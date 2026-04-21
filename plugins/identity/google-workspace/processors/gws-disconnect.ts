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
import { deactivateOAuthToken } from '@/lib/db/oauth';
import { getAgencyKeycloakConfig } from '@/lib/db/settings';

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
      }
    }

    // Step 2 — delete Keycloak SAML client
    const spEntityId = cfg.samlSpEntityId as string | undefined;
    if (spEntityId && isKeycloakAdminConfigured()) {
      const { keycloakRealm } = await getAgencyKeycloakConfig(tenantId);
      await deleteKeycloakSamlClient(keycloakRealm, spEntityId);
    }

    // Step 3 — no-op for GWS.

    // Step 4 — deactivate OAuth token row
    if (source.oauth_token_id) {
      await deactivateOAuthToken(source.oauth_token_id);
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
      actor: { type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'google-workspace', triggeredBy: (job.data as { triggeredBy?: string }).triggeredBy },
    }).catch(() => {});

    logger.info('gws_disconnect: completed', { jobId, sourceId });
    return { status: 'completed', jobType: 'gws_disconnect' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: {
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
      actor: { type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'google-workspace', error: message },
    }).catch(() => {});

    throw err;  // Bull retries.
  }
}
