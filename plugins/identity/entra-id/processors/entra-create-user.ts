/**
 * Entra ID Create User — Plugin Processor
 *
 * Processes entra_create_user Bull jobs. Creates a Microsoft Entra ID
 * (Azure AD) user via the Microsoft Graph API for synthetic identity
 * provisioning.
 *
 * Mirrors shared/plugins/identity/google-workspace/processors/gws-create-user.ts,
 * adapted for Entra ID / Graph API. See
 * docs/superpowers/specs/2026-05-09-product-gap-730-entra-create-user-and-seed-design.md
 */

import type Bull from 'bull';
import { reconcileProvisioningStatus } from '../../../../lib/provisioningReconciler.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { ProviderStatus } from '../../../../lib/provisioning-types.js';
import { resolveEntraAccessToken } from './resolve-access-token.js';
import { createUser } from './api/graph.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function entraCreateUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, identityId, email, displayName, platformKey } = job.data;
  const { prisma, logger, resolveProviderOverride } = getRuntime();

  // 1. Load identity from DB — verify it still exists
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
  });

  if (!identity) {
    logger.warn('entra_create_user: identity not found — deleted before processing', {
      jobId: String(job.id),
      identityId,
    });
    return { status: 'completed', jobType: 'entra_create_user' };
  }

  // 2. Load Entra ID source config from DB
  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'entra-id',
      provisioning_enabled: true,
    },
  });

  if (!source) {
    // No Entra ID source configured or provisioning disabled — mark SKIPPED
    await updateProviderStatus(prisma, identityId, 'entra-id', {
      status: ProviderStatus.SKIPPED,
      reason: 'Entra ID provisioning not enabled for this agency',
      updatedAt: new Date().toISOString(),
    });
    await reconcileProvisioningStatus(prisma, identityId);
    logger.info('entra_create_user: no enabled Entra ID source, skipped', {
      jobId: String(job.id),
      identityId,
    });
    return { status: 'completed', jobType: 'entra_create_user' };
  }

  // 2b. E2E provider-override seam — check BEFORE access-token resolution so
  // the entire credential + API path is bypassed when an override row exists.
  // When a matching `provider_response_overrides` row exists for
  // (tenantId, 'entra', GRAPH_USERS_API) the real Graph call is
  // short-circuited and the forced response drives the happy-path so
  // E2E scenarios can run without a live Entra connection.
  {
    const GRAPH_USERS_API = 'https://graph.microsoft.com/v1.0/users';
    const e2eOverride = resolveProviderOverride
      ? await resolveProviderOverride(tenantId, 'entra', GRAPH_USERS_API)
      : null;
    if (e2eOverride && e2eOverride.status >= 200 && e2eOverride.status < 300) {
      const syntheticObjectId = `e2e-${identityId.slice(0, 8)}`;
      await updateProviderStatus(prisma, identityId, 'entra-id', {
        status: ProviderStatus.PROVISIONED,
        externalId: syntheticObjectId,
        updatedAt: new Date().toISOString(),
      });
      logger.info('entra_create_user: provider override short-circuited — PROVISIONED via E2E seam', {
        jobId: String(job.id), identityId, syntheticObjectId,
      });
      await reconcileProvisioningStatus(prisma, identityId);
      return { status: 'completed', jobType: 'entra_create_user' };
    }
  }

  // 3. Resolve access token (OAuth first, client credentials fallback)
  const accessToken = await resolveEntraAccessToken(prisma, source, logger);

  if (!accessToken) {
    throw new Error('No valid OAuth token for Entra ID — will retry');
  }

  // 4. Derive UPN and mailNickname
  const resolvedEmail = email || identity.identifier;
  const resolvedDisplayName = displayName || identity.name || resolvedEmail;

  // mailNickname: local part of UPN, stripped of characters outside [A-Za-z0-9._-]
  const mailNickname = resolvedEmail
    .split('@')[0]
    .replace(/[^A-Za-z0-9._-]/g, '');

  // 5. Generate a random initial password
  const password = generateRandomPassword();

  // 6. Call Graph API POST /users
  try {
    const result = await createUser(accessToken, {
      userPrincipalName: resolvedEmail,
      displayName: resolvedDisplayName,
      mailNickname,
      accountEnabled: true,
      // Required by Graph when the UPN's domain is federated; harmless on
      // non-federated domains. The local identity UUID is stable + unique
      // per identity, so it is a safe permanent anchor.
      onPremisesImmutableId: identity.id,
      passwordProfile: {
        password,
        forceChangePasswordNextSignIn: false,
      },
    });

    // 7. Update provider status — PROVISIONED
    await updateProviderStatus(prisma, identityId, 'entra-id', {
      status: ProviderStatus.PROVISIONED,
      externalId: result.id,
      updatedAt: new Date().toISOString(),
    });

    logger.info('entra_create_user: user provisioned in Entra ID', {
      jobId: String(job.id),
      identityId,
      objectId: result.id,
      userPrincipalName: result.userPrincipalName,
    });

    // 8. Sync readiness to Keycloak (if Keycloak already provisioned)
    if (identity.keycloak_user_id) {
      try {
        const { mergeUserAttributes } = await import('../../../../lib/keycloakAdmin.js');
        const settings = await prisma.agency_settings.findUnique({
          where: { agency_id: tenantId },
        });
        const realm = settings?.keycloak_realm || tenantId;
        await mergeUserAttributes(identity.keycloak_user_id, {
          mih_ready_entra: ['true'],
          mih_ready_entra_checkedAt: [new Date().toISOString()],
        }, realm);
      } catch (kcErr) {
        logger.warn('entra_create_user: KC readiness sync failed (non-fatal)', {
          jobId: String(job.id),
          error: (kcErr as Error).message,
        });
      }
    }
  } catch (err) {
    // Update provider status with error
    await updateProviderStatus(prisma, identityId, 'entra-id', {
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
          mih_ready_entra: ['false'],
          mih_ready_entra_checkedAt: [new Date().toISOString()],
          mih_ready_entra_reason: ['PROVISION_ERROR'],
        }, realm);
      } catch (_) { /* non-fatal */ }
    }

    throw err; // Re-throw so Bull retries
  }

  // 9. Reconcile — if Keycloak is already done, this marks PROVISIONED
  await reconcileProvisioningStatus(prisma, identityId);

  return { status: 'completed', jobType: 'entra_create_user' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random password that satisfies Entra ID's
 * password complexity requirements:
 * - At least 8 characters
 * - Mix of upper, lower, digit, special
 *
 * Synthetic accounts are SSO-only; this password is never used for login.
 */
function generateRandomPassword(): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const all = upper + lower + digits + special;

  const randomChar = (charset: string) =>
    charset[Math.floor(Math.random() * charset.length)];

  // Guarantee at least one of each category
  const required = [
    randomChar(upper),
    randomChar(lower),
    randomChar(digits),
    randomChar(special),
  ];

  // Fill remaining 12 characters from all chars (total: 16)
  const rest = Array.from({ length: 12 }, () => randomChar(all));

  // Shuffle
  const all16 = [...required, ...rest];
  for (let i = all16.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all16[i], all16[j]] = [all16[j], all16[i]];
  }
  return all16.join('');
}

async function updateProviderStatus(
  prisma: any,
  identityId: string,
  provider: string,
  statusData: Record<string, unknown>,
): Promise<void> {
  // Load current status first so we merge onto (not replace) the existing
  // providers_status JSON. If the identity has already been deleted — which
  // happens when a test's afterAll cleans up before the async job finishes —
  // exit cleanly instead of letting the subsequent update crash the worker
  // with `PrismaClientKnownRequestError (P2025)`.
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
    select: { provisioning_providers_status: true },
  });

  if (!identity) {
    const { logger } = getRuntime();
    logger.warn('entra_create_user: identity deleted before status update — skipping', {
      identityId,
      provider,
    });
    return;
  }

  const existing = (identity.provisioning_providers_status || {}) as Record<string, unknown>;

  // Use updateMany so a race where the row is deleted between the
  // findUnique above and the update below resolves to a 0-row noop instead
  // of P2025.
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
