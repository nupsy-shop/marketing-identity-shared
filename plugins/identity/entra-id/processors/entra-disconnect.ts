/**
 * Entra ID Disconnect — Plugin Processor
 *
 * Hard-disconnects an Entra ID identity source. Same shape as
 * gws_disconnect with two differences:
 *
 *   - Step 1 is a log-only no-op. Microsoft provides no first-party
 *     refresh-token revoke endpoint for app-permissioned OAuth. Token
 *     deactivation (step 4) stops use; expiry completes invalidation.
 *   - Step 3 deletes the single Entra IdP broker in Keycloak (fixed
 *     alias 'azure-ad' — see shared/lib/identity/sso/iam-upsert-realm-idp.ts
 *     aliasForProvider). federatedDomains is a list of domains routed
 *     through that single broker; deleting the broker severs federation
 *     for all of them.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import {
  deleteKeycloakSamlClient,
  deleteRealmIdentityProvider,
  isKeycloakAdminConfigured,
} from '../../../../lib/keycloakAdmin.js';
// These were web-app-only helpers (`@/lib/db/...`). Inlined below as
// runtime Prisma calls so this processor is portable to the worker.

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: 'entra_disconnect';
  reason?: string;
}

const SSO_FIELDS_TO_CLEAR = [
  'samlSpEntityId',
  'samlAcsUrl',
  'ssoVerifiedAt',
  'ssoProfileAttested',
  'ssoConfirmedAt',
  'connectionMode',
  'federatedDomains',
] as const;

const ENTRA_IDP_ALIAS = 'azure-ad';

function stripSsoFields(cfg: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cfg };
  for (const f of SSO_FIELDS_TO_CLEAR) delete out[f];
  return out;
}

export default async function entraDisconnect(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId } = job.data as { tenantId: string; sourceId: string };
  const jobId = String(job.id);

  const source = await prisma.identity_sources.findFirst({
    where: { id: sourceId, agency_id: tenantId, plugin_key: 'entra-id' },
  });
  if (!source) {
    logger.info('entra_disconnect: source not found — skipping', { jobId, sourceId });
    return { status: 'skipped', jobType: 'entra_disconnect', reason: 'source not found' };
  }

  const cfg = (source.connection_config ?? {}) as Record<string, unknown>;

  try {
    // Step 1 — no-op for Entra (no refresh-token revoke endpoint).
    logger.info('entra_disconnect: step 1 (revoke) is a no-op for Entra — relying on token deactivation + TTL expiry', { jobId });

    // Step 2 — delete Keycloak SAML client
    if (isKeycloakAdminConfigured()) {
      // Inline of getAgencyKeycloakConfig(tenantId): only use the realm
      // when the agency has an active Keycloak realm configured.
      const settings = await prisma.agency_settings.findFirst({
        where: { agency_id: tenantId },
        select: { keycloakRealm: true, keycloakRealmStatus: true },
      });
      const keycloakRealm =
        settings?.keycloakRealmStatus === 'active' ? settings.keycloakRealm : null;
      if (keycloakRealm) {
        const spEntityId = cfg.samlSpEntityId as string | undefined;
        if (spEntityId) {
          await deleteKeycloakSamlClient(keycloakRealm, spEntityId);
        }

        // Step 3 — delete Entra IdP broker (single fixed alias)
        await deleteRealmIdentityProvider(keycloakRealm, ENTRA_IDP_ALIAS);
      }
    }

    // Step 4 — deactivate OAuth token row (inline of deactivateOAuthToken)
    if (source.oauth_token_id) {
      await prisma.oauth_tokens.update({
        where: { id: source.oauth_token_id },
        data: { isActive: false, updatedAt: new Date() },
      });
    }

    // Step 5 — clear SSO config + flip state
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
      source: 'entra-id',
      severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'entra-id', triggeredBy: (job.data as { triggeredBy?: string }).triggeredBy },
    }).catch(() => {});

    logger.info('entra_disconnect: completed', { jobId, sourceId });
    return { status: 'completed', jobType: 'entra_disconnect' };
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
      source: 'entra-id',
      severity: 'error',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_sources', id: sourceId },
      context: { pluginKey: 'entra-id', error: message },
    }).catch(() => {});

    throw err;
  }
}
