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
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import { validateScopesForMode } from '../tokens.js';
import { ensureSyntheticKcUser } from './ensure-synthetic-kc-user.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function gwsCreateUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, identityId, email, displayName, platformKey } = job.data;
  const { prisma, logger, resolveProviderOverride } = getRuntime();

  // 1. Load identity from DB — verify it still exists
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
  });

  if (!identity) {
    logger.warn('gws_create_user: identity not found — deleted before processing', { jobId: String(job.id), identityId });
    return { status: 'completed', jobType: 'gws_create_user' };
  }

  // 1b. Guard: a null tenantId makes the identity_sources.findFirst below throw
  // "Argument agency_id must not be null" (Prisma rejects null equality on a
  // required column), surfacing as an opaque job failure. This should never
  // reach the queue — the enqueue side now refuses it — but treat a malformed
  // legacy/replayed job as ERROR with a clear reason instead of a hard throw.
  if (!tenantId) {
    logger.error('gws_create_user: job missing tenantId — cannot resolve GWS source', { jobId: String(job.id), identityId });
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.ERROR,
      reason: 'Missing tenant id on provisioning job — agency could not be resolved',
      updatedAt: new Date().toISOString(),
    });
    await reconcileProvisioningStatus(prisma, identityId);
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

  // 2b. E2E provider-override seam — check BEFORE OAuth resolution so the
  // entire credential + API path is bypassed when an override row exists.
  // When a matching `provider_response_overrides` row exists for
  // (tenantId, 'gws', GWS_USERS_API) the real Admin SDK call is
  // short-circuited and the forced response drives the happy-path so
  // E2E scenarios can run without a live GWS connection.
  {
    const GWS_USERS_API = 'https://admin.googleapis.com/admin/directory/v1/users';
    const e2eOverride = resolveProviderOverride
      ? await resolveProviderOverride(tenantId, 'gws', GWS_USERS_API)
      : null;
    if (e2eOverride && e2eOverride.status >= 200 && e2eOverride.status < 300) {
      const syntheticUserId = `e2e-${identityId.slice(0, 8)}`;
      await updateProviderStatus(prisma, identityId, 'google-workspace', {
        status: ProviderStatus.PROVISIONED,
        externalId: syntheticUserId,
        updatedAt: new Date().toISOString(),
      });
      logger.info('gws_create_user: provider override short-circuited — PROVISIONED via E2E seam', {
        jobId: String(job.id), identityId, syntheticUserId,
      });
      await reconcileProvisioningStatus(prisma, identityId);
      return { status: 'completed', jobType: 'gws_create_user' };
    }
  }

  // 3. Resolve OAuth access token (with refresh if expired)
  // Wrapped in try/catch so any throw here marks the provider status as
  // ERROR before re-throwing — without this, OAuth-failure throws leave
  // `provisioning_providers_status['google-workspace']` frozen at its
  // prior value (FAILED/null), masking the failure mode from operators
  // and downstream automations (#985 #1714).
  let accessToken: string | null = null;
  let tokenScopes: string[] = [];
  try {
    if (source.oauth_token_id) {
      const token = await prisma.oauth_tokens.findUnique({
        where: { id: source.oauth_token_id },
      });
      if (token && token.isActive !== false) {
        tokenScopes = (token.scopes as string[]) ?? [];
        const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
        const isExpired = Date.now() > expiresAt - 5 * 60 * 1000; // 5 min buffer

        if (isExpired && token.refreshToken) {
          // Refresh the token
          const refreshed = await refreshGoogleToken(prisma, token);
          if (refreshed) {
            accessToken = refreshed;
            // refreshGoogleToken updates the token row with the new scope
            // string (if Google returned one); re-read to pick that up.
            const refreshedToken = await prisma.oauth_tokens.findUnique({
              where: { id: source.oauth_token_id },
            });
            tokenScopes = (refreshedToken?.scopes as string[]) ?? tokenScopes;
          } else {
            // Refresh failed — do NOT fall back to expired token.
            // Using a stale token produces misleading 403 errors.
            throw new Error(
              'Google Workspace OAuth token refresh failed. The agency may need to reconnect Google Workspace in Settings → Identity Sources.'
            );
          }
        } else if (isExpired && !token.refreshToken) {
          throw new Error(
            'Google Workspace OAuth token expired and no refresh token is stored. The agency must reconnect Google Workspace in Settings → Identity Sources.'
          );
        } else {
          accessToken = token.accessToken;
        }
      }
    }

    if (!accessToken) {
      logger.error(
        'gws_create_user: no valid OAuth token — agency may need to reconnect',
        {
          jobId: String(job.id),
          tenantId,
          identityId,
          sourceId: source.id,
          oauthTokenId: source.oauth_token_id,
        },
      );
      throw new Error('No valid OAuth token for Google Workspace — will retry');
    }
  } catch (oauthErr) {
    const errMsg = (oauthErr as Error).message;
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.ERROR,
      error: errMsg,
      updatedAt: new Date().toISOString(),
    });
    await reconcileProvisioningStatus(prisma, identityId);
    throw oauthErr;
  }

  // 3b. Scope pre-check — provisioning requires write scopes on the OAuth
  // token. If the source was connected in READ_ONLY mode (a real legitimate
  // configuration — read-only is the default for tenants who don't need
  // synthetic provisioning) we skip cleanly with a SKIPPED status rather
  // than wasting an Admin API call and surfacing a noisy 403. Operators
  // who want provisioning must upgrade to PROVISIONING mode via the
  // GWS source page (handleModeUpgrade in the layout).
  const scopeCheck = validateScopesForMode(tokenScopes, 'PROVISIONING');
  if (!scopeCheck.valid) {
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.SKIPPED,
      reason:
        `Google Workspace connected in READ_ONLY mode — provisioning skipped. ` +
        `Upgrade to PROVISIONING mode in Settings → Identity Sources to enable ` +
        `synthetic user creation. Missing scopes: ${scopeCheck.missing.join(', ')}`,
      updatedAt: new Date().toISOString(),
    });
    await reconcileProvisioningStatus(prisma, identityId);
    logger.info(
      'gws_create_user: skipped — token lacks PROVISIONING scopes (READ_ONLY mode)',
      {
        jobId: String(job.id),
        tenantId,
        identityId,
        sourceId: source.id,
        missing: scopeCheck.missing,
      },
    );
    return { status: 'completed', jobType: 'gws_create_user' };
  }

  // 4. Resolve syntheticOrgUnitPath
  const provConfig = (source.provisioning_config || {}) as Record<string, unknown>;
  const connConfig = (source.connection_config || {}) as Record<string, unknown>;
  const syntheticOrgUnitPath = (provConfig.syntheticOrgUnitPath || connConfig.managedOuPath) as string | undefined;

  if (!syntheticOrgUnitPath) {
    logger.error(
      'gws_create_user: syntheticOrgUnitPath not configured (neither provisioning_config.syntheticOrgUnitPath nor connection_config.managedOuPath is set)',
      {
        jobId: String(job.id),
        tenantId,
        identityId,
        sourceId: source.id,
        provConfigKeys: Object.keys(provConfig),
        connConfigKeys: Object.keys(connConfig),
      },
    );
    throw new Error(
      'syntheticOrgUnitPath not configured on Google Workspace identity source — set provisioning_config.syntheticOrgUnitPath or connection_config.managedOuPath',
    );
  }

  // 5. Call GWS Admin API — real path (override seam was checked in step 2b).
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

    // 6b. Ensure a Keycloak user for this synthetic identity so a later identity-
    // assuming session (#2312) can impersonate it into the delegated-OU Google
    // SAML login. The realm's Google SAML client already maps NameID = email.
    try {
      const { createKeycloakUser, addKeycloakUserToGroup, updateKeycloakUserProfile } = await import('../../../../lib/keycloakAdmin.js');
      const kcSettings = await prisma.agency_settings.findUnique({ where: { agency_id: tenantId } });
      const kcRealm = kcSettings?.keycloak_realm || tenantId;
      const [givenName, ...rest] = (resolvedDisplayName || resolvedEmail).split(' ');
      await ensureSyntheticKcUser({
        prisma,
        createKeycloakUser,
        addToSyntheticGroup: (uid: string) => addKeycloakUserToGroup(kcRealm, uid, 'PamSyntheticIdentities', tenantId),
        updateKeycloakUser: (uid, profile, r) => updateKeycloakUserProfile(uid, profile, r, tenantId),
        realm: kcRealm,
        agencyId: tenantId,
        identityId,
        primaryEmail: result.primaryEmail || resolvedEmail,
        givenName: givenName || 'PAM',
        familyName: rest.join(' ') || 'Identity',
        existingKeycloakUserId: identity.keycloak_user_id ?? null,
      });
      // Refresh the local copy so the readiness sync below sees the new id.
      identity.keycloak_user_id =
        identity.keycloak_user_id ??
        (await prisma.integration_identities.findUnique({
          where: { id: identityId }, select: { keycloak_user_id: true },
        }))?.keycloak_user_id ?? null;
    } catch (kcUserErr) {
      logger.warn('gws_create_user: ensureSyntheticKcUser failed (non-fatal)', {
        identityId, error: kcUserErr instanceof Error ? kcUserErr.message : String(kcUserErr),
      });
    }

    // Emit canonical audit event for dedicated identity provisioned via GWS.
    // Fire-and-forget: a publisher hiccup must not fail the job.
    publishAuditEvent({
      eventType: 'identity.dedicated.provisioned',
      source: 'accesshive',
      severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity', id: identityId, name: identity.name ?? undefined },
      context: {
        identityId,
        provider: 'google-workspace',
        externalUserId: result.userId,
        jobId: String(job.id),
        _legacyEvent: 'IDENTITY_PROVISIONED',
      },
    }).catch(() => {});

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
    // Log the precise GWS API error with full context BEFORE writing
    // provider status — without this the failure surfaces only as a
    // generic "Job failed" line and the operator has to dig into
    // provisioning_providers_status to find out why (#985).
    const errMsg = (err as Error).message;
    logger.error(
      'gws_create_user: GWS Admin API call failed — see error for upstream cause (most common: 403 insufficient scope, 404 OU not found, 409 user already exists in a different OU)',
      {
        jobId: String(job.id),
        tenantId,
        identityId,
        sourceId: source.id,
        email: resolvedEmail,
        syntheticOrgUnitPath,
        oauthTokenId: source.oauth_token_id,
        err: errMsg,
      },
    );

    // Update provider status with error
    await updateProviderStatus(prisma, identityId, 'google-workspace', {
      status: ProviderStatus.ERROR,
      error: errMsg,
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
      let errorText = '';
      try { errorText = await res.text(); } catch { /* ignore */ }
      const { logger: log } = getRuntime();
      log.error('gws_create_user: Google OAuth token refresh failed', {
        tokenId: token.id,
        status: res.status,
        error: errorText,
      });
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
  // Load current status first so we merge onto (not replace) the existing
  // providers_status JSON. If the identity has already been deleted — which
  // happens when a test's afterAll cleans up before the async GWS job
  // finishes — exit cleanly instead of letting the subsequent update crash
  // the worker with `PrismaClientKnownRequestError (P2025): No record was
  // found for an update.`
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
    select: { provisioning_providers_status: true },
  });

  if (!identity) {
    const { logger } = getRuntime();
    logger.warn('gws_create_user: identity deleted before status update — skipping', {
      identityId, provider,
    });
    return;
  }

  const existing = (identity.provisioning_providers_status || {}) as Record<string, unknown>;

  // Use updateMany so a race where the row is deleted between the
  // findUnique above and the update below resolves to a 0-row noop instead
  // of P2025. Cheap belt-and-suspenders for the cleanup race.
  await prisma.integration_identities.updateMany({
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
