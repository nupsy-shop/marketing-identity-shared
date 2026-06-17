/**
 * GWS Disconnect — Plugin Processor
 *
 * Hard-disconnects a Google Workspace identity source. Runs five
 * idempotent steps in order:
 *
 *   1. Revoke refresh token at Google via oauth2.googleapis.com/revoke.
 *   2. Delete Keycloak SAML client matching connection_config.samlSpEntityId.
 *   3. (No IdP broker step — GWS uses SAML client only.)
 *   4. Deactivate the oauth_tokens row.
 *   5. Clear SSO config in connection_config + flip connection_state to
 *      'disconnected'.
 *
 * Each step tolerates "already gone" (Google 400 invalid_token, Keycloak
 * 404). Any non-idempotent error throws for Bull retry; on terminal
 * failure the catch block flips connection_state to 'degraded' and
 * stores disconnect_error in connection_config so the operator can see
 * what went wrong and retry.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import { deleteKeycloakSamlClient, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';
// These were web-app-only helpers (`@/lib/db/...`). Inlined below as
// runtime Prisma calls so this processor is portable to the worker.

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: 'gws_disconnect';
  reason?: string;
}

const SSO_FIELDS_TO_CLEAR = [
  'samlSpEntityId',
  'samlAcsUrl',
  'ssoVerifiedAt',
  'ssoProfileAttested',
  'ssoConfirmedAt',
  'connectionMode',
] as const;

function stripSsoFields(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const f of SSO_FIELDS_TO_CLEAR) delete out[f];
  return out;
}

export default async function gwsDisconnect(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId } = job.data as { tenantId: string; sourceId: string };
  const jobId = String(job.id);

  const source = await prisma.identity_sources.findFirst({
    where: { id: sourceId, agency_id: tenantId, plugin_key: 'google-workspace' },
  });
  if (!source) {
    logger.info('gws_disconnect: source not found — skipping', { jobId, sourceId });
    return { status: 'skipped', jobType: 'gws_disconnect', reason: 'source not found' };
  }

  const cfg = (source.connection_config ?? {}) as Record<string, unknown>;

  // Once Step 1 revokes the Google grant, the stored token is dead — the local
  // teardown MUST then run even if a later step fails, or the source is left
  // pointing at a revoked token and the health probe pins it to `needs_reauth`.
  let revoked = false;

  try {
    // Step 1 — revoke refresh token at Google
    if (source.oauth_token_id) {
      const token = await prisma.oauth_tokens.findUnique({ where: { id: source.oauth_token_id } });
      if (token?.refreshToken) {
        const res = await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `token=${encodeURIComponent(token.refreshToken)}`,
        });
        if (!res.ok) {
          if (res.status === 400) {
            // 400 invalid_token — already revoked at Google. Success.
            logger.info('gws_disconnect: Google revoke returned 400 (already revoked)', { jobId });
          } else {
            throw new Error(`Google revoke failed: HTTP ${res.status}`);
          }
        }
        revoked = true;
      }
    }

    // Step 2 — delete Keycloak SAML client (best-effort cleanup).
    //
    // This runs AFTER Step 1 has already revoked the Google refresh token, so a
    // failure here must NOT abort the local teardown (Steps 4-5) — otherwise the
    // source is left pointing at a now-dead token and the platform-health probe
    // flips it to `needs_reauth` forever. We log + continue on any error; an
    // orphaned SAML client is recoverable, a stranded revoked token is not.
    //
    // (The select uses the real snake_case columns `keycloak_realm` /
    // `keycloak_realm_status`; the prior camelCase select threw `Unknown field`
    // at runtime — undetected because `getRuntime().prisma` is `any` — which is
    // exactly what was crashing every disconnect.)
    const spEntityId = cfg.samlSpEntityId as string | undefined;
    if (spEntityId && isKeycloakAdminConfigured()) {
      try {
        const settings = await prisma.agency_settings.findFirst({
          where: { agency_id: tenantId },
          select: { keycloak_realm: true, keycloak_realm_status: true },
        });
        const keycloakRealm =
          settings?.keycloak_realm_status === 'active' ? settings.keycloak_realm : null;
        if (keycloakRealm) {
          await deleteKeycloakSamlClient(keycloakRealm, spEntityId);
        }
      } catch (kcErr) {
        logger.warn('gws_disconnect: Keycloak SAML cleanup failed — continuing teardown', {
          jobId,
          sourceId,
          error: kcErr instanceof Error ? kcErr.message : String(kcErr),
        });
      }
    }

    // Step 3 — no-op for GWS.

    // Step 4 — deactivate OAuth token row (inline of deactivateOAuthToken)
    if (source.oauth_token_id) {
      await prisma.oauth_tokens.update({
        where: { id: source.oauth_token_id },
        data: { isActive: false, updatedAt: new Date() },
      });
    }

    // Step 5 — clear SSO config + flip state to disconnected
    const nextCfg = {
      ...stripSsoFields(cfg),
      disconnectedAt: new Date().toISOString(),
      disconnect_error: null,
      disconnect_error_at: null,
    };
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: {
        connection_state: 'disconnected',
        oauth_token_id: null,
        granted_scopes: [],
        provisioning_enabled: false,
        connection_config: nextCfg as never,
        updated_at: new Date(),
      },
    });

    publishAuditEvent({
      eventType: 'identity.source.disconnected',
      source: 'google-workspace',
      severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'google-workspace', triggeredBy: (job.data as { triggeredBy?: string }).triggeredBy },
    }).catch(() => {});

    logger.info('gws_disconnect: completed', { jobId, sourceId });
    return { status: 'completed', jobType: 'gws_disconnect' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the Google grant was already revoked, the token is dead regardless of
    // what failed next — finish the teardown (null the token ref + mark
    // disconnected) so the health probe stops re-flagging `needs_reauth`. Only
    // when the revoke itself never succeeded do we fall back to `degraded` so a
    // Bull retry can re-attempt against a still-live token.
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: revoked
        ? {
            connection_state: 'disconnected',
            oauth_token_id: null,
            granted_scopes: [],
            provisioning_enabled: false,
            connection_config: {
              ...stripSsoFields(cfg),
              disconnectedAt: new Date().toISOString(),
              disconnect_error: message,
              disconnect_error_at: new Date().toISOString(),
            } as never,
            updated_at: new Date(),
          }
        : {
            connection_state: 'degraded',
            connection_config: {
              ...cfg,
              disconnect_error: message,
              disconnect_error_at: new Date().toISOString(),
            } as never,
            updated_at: new Date(),
          },
    }).catch(() => {});

    publishAuditEvent({
      eventType: 'identity.source.disconnect.failed',
      source: 'google-workspace',
      severity: 'error',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'google-workspace', error: message },
    }).catch(() => {});

    throw err;  // Bull retries.
  }
}
