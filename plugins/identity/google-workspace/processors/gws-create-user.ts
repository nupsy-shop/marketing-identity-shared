/**
 * GWS Create User — Plugin Processor
 *
 * Processes gws_create_user Bull jobs. Creates a Google Workspace user
 * and places them in the configured synthetic OU for SSO delegation.
 *
 * This processor is plugin-owned: it lives in the shared submodule under
 * the google-workspace plugin directory and is loaded dynamically by
 * the worker via processors-manifest.json.
 */

import type Bull from 'bull';
import { reconcileProvisioningStatus } from '../../../../lib/provisioningReconciler.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { ProviderStatus } from '../../../../lib/provisioning-types.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function gwsCreateUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, identityId, email, displayName, platformKey } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Load identity from DB — verify it still exists
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
  });

  if (!identity) {
    logger.warn('gws_create_user: identity not found — deleted before processing', { jobId: String(job.id), identityId });
    return { status: 'completed', jobType: 'gws_create_user' };
  }

  // 2. Load GWS source config from DB
  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'google-workspace',
      provisioning_enabled: true,
    },
  });

  if (!source) {
    // No GWS source configured or provisioning disabled — mark SKIPPED
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.SKIPPED,
      reason: 'Google Workspace provisioning not enabled for this agency',
      updatedAt: new Date().toISOString(),
    });
    await reconcileProvisioningStatus(prisma, identityId);
    logger.info('gws_create_user: no enabled GWS source, skipped', { jobId: String(job.id), identityId });
    return { status: 'completed', jobType: 'gws_create_user' };
  }

  // 3. Resolve OAuth access token (with refresh if expired)
  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({
      where: { id: source.oauth_token_id },
    });
    if (token && token.isActive !== false) {
      const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
      const isExpired = Date.now() > expiresAt - 5 * 60 * 1000; // 5 min buffer

      if (isExpired && token.refreshToken) {
        // Refresh the token
        const refreshed = await refreshGoogleToken(prisma, token);
        if (refreshed) {
          accessToken = refreshed;
        } else {
          // Refresh failed — try existing token as last resort
          accessToken = token.accessToken;
        }
      } else {
        accessToken = token.accessToken;
      }
    }
  }

  if (!accessToken) {
    throw new Error('No valid OAuth token for Google Workspace — will retry');
  }

  // 4. Resolve syntheticOrgUnitPath
  const provConfig = (source.provisioning_config || {}) as Record<string, unknown>;
  const connConfig = (source.connection_config || {}) as Record<string, unknown>;
  const syntheticOrgUnitPath = (provConfig.syntheticOrgUnitPath || connConfig.managedOuPath) as string | undefined;

  if (!syntheticOrgUnitPath) {
    throw new Error('syntheticOrgUnitPath not configured — will retry');
  }

  // 5. Call GWS Admin API
  const { ensureUserInOu } = await import('./api/provisioning.js');

  const resolvedEmail = email || identity.identifier;
  const resolvedDisplayName = displayName || identity.name || resolvedEmail;

  try {
    const result = await ensureUserInOu(accessToken, {
      primaryEmail: resolvedEmail,
      givenName: resolvedDisplayName.split(' ')[0] || 'PAM',
      familyName: resolvedDisplayName.split(' ').slice(1).join(' ') || platformKey || 'Identity',
      orgUnitPath: syntheticOrgUnitPath,
    });

    // 6. Update provider status
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.PROVISIONED,
      externalId: result.userId,
      updatedAt: new Date().toISOString(),
    });

    logger.info('gws_create_user: user provisioned in Google Workspace', {
      jobId: String(job.id), identityId, userId: result.userId, created: String(result.created),
    });

    // 7. Sync readiness to Keycloak (if Keycloak already provisioned)
    if (identity.keycloak_user_id) {
      try {
        const { mergeUserAttributes } = await import('../../../../lib/keycloakAdmin.js');
        const settings = await prisma.agency_settings.findUnique({
          where: { agency_id: tenantId },
        });
        const realm = settings?.keycloak_realm || tenantId;
        await mergeUserAttributes(identity.keycloak_user_id, {
          mih_ready_google: ['true'],
          mih_ready_google_checkedAt: [new Date().toISOString()],
        }, realm);
      } catch (kcErr) {
        logger.warn('gws_create_user: KC readiness sync failed (non-fatal)', {
          jobId: String(job.id), error: (kcErr as Error).message,
        });
      }
    }
  } catch (err) {
    // Update provider status with error
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.ERROR,
      error: (err as Error).message,
      updatedAt: new Date().toISOString(),
    });

    // Sync failure to Keycloak
    if (identity.keycloak_user_id) {
      try {
        const { mergeUserAttributes } = await import('../../../../lib/keycloakAdmin.js');
        const settings = await prisma.agency_settings.findUnique({
          where: { agency_id: tenantId },
        });
        const realm = settings?.keycloak_realm || tenantId;
        await mergeUserAttributes(identity.keycloak_user_id, {
          mih_ready_google: ['false'],
          mih_ready_google_checkedAt: [new Date().toISOString()],
          mih_ready_google_reason: ['PROVISION_ERROR'],
        }, realm);
      } catch (_) { /* non-fatal */ }
    }

    throw err; // Re-throw so Bull retries
  }

  // 8. Reconcile — if Keycloak is already done, this marks PROVISIONED
  await reconcileProvisioningStatus(prisma, identityId);

  return { status: 'completed', jobType: 'gws_create_user' };
}

// ─── Token Refresh ───────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function refreshGoogleToken(
  prisma: any,
  token: { id: string; refreshToken: string | null; scopes: string[]; [key: string]: unknown },
): Promise<string | null> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken || '',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    const expiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

    // Update stored token in DB
    await prisma.oauth_tokens.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        expiresAt,
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        ...(data.scope ? { scopes: data.scope.split(' ') } : {}),
        updatedAt: new Date(),
      },
    });

    return data.access_token;
  } catch {
    return null;
  }
}

// ── Helper ────────────────────────────────────────────────────────────────

async function updateProviderStatus(
  prisma: any,
  identityId: string,
  provider: string,
  statusData: Record<string, unknown>,
): Promise<void> {
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
    select: { provisioning_providers_status: true },
  });

  const existing = (identity?.provisioning_providers_status || {}) as Record<string, unknown>;

  await prisma.integration_identities.update({
    where: { id: identityId },
    data: {
      provisioning_providers_status: {
        ...existing,
        [provider]: statusData,
      },
      updatedAt: new Date(),
    },
  });
}
