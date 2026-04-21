/**
 * Keycloak Create User — Dedicated Identities Only
 *
 * Creates a Keycloak user account for a dedicated identity
 * (HUMAN_INTERACTIVE or SERVICE_ACCOUNT). Skips SHARED_CREDENTIAL.
 *
 * Payload:
 *   tenantId    — agency ID
 *   identityId  — integration_identities.id
 *
 * Other IAM operations use separate job types:
 *   iam_provision_app_user  — local directory users
 *   iam_provision_realm     — agency realm setup
 *   saml_client_configure   — SAML SSO config
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { createKeycloakUser, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';
import { reconcileProvisioningStatus } from '../../../../lib/provisioningReconciler.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: string;
  reason?: string;
}

export default async function keycloakCreateUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, identityId, pluginKey, triggeredBy } = job.data as {
    tenantId: string;
    identityId: string;
    pluginKey?: string;
    triggeredBy?: string;
  };

  if (!isKeycloakAdminConfigured()) {
    logger.warn('Keycloak admin not configured, skipping', { jobId: job.id, tenantId });
    return { status: 'completed', jobType: 'iam_provision_identity' };
  }

  if (!identityId) {
    logger.warn('No identityId provided, skipping', { jobId: job.id, tenantId });
    return { status: 'completed', jobType: 'iam_provision_identity' };
  }

  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
  });

  if (!identity) {
    logger.warn('Identity not found — already deleted, skipping', { jobId: job.id, tenantId, identityId });
    return { status: 'completed', jobType: 'iam_provision_identity' };
  }

  // JML joiner gate. If this job was fanned out by the JML lifecycle pipeline
  // (triggeredBy='jml_process_lifecycle' + pluginKey set in the payload by
  // lifecycle-processor's dispatchPrimary), honor the source's per-source
  // overrides. Checkout-driven synthetic-identity creation does not set these
  // fields, so the gate is inert for that flow.
  if (triggeredBy === 'jml_process_lifecycle' && pluginKey) {
    const source = await prisma.identity_sources.findFirst({
      where: { agency_id: tenantId, plugin_key: pluginKey },
      select: { connection_config: true },
    });

    if (!source) {
      const reason = `source not found for plugin ${pluginKey}`;
      logger.info('iam_provision_identity: JML joiner skipped', {
        jobId: String(job.id), tenantId, identityId, pluginKey, reason,
      });
      return { status: 'skipped', jobType: 'iam_provision_identity', reason };
    }

    const cfg = (source.connection_config ?? {}) as Record<string, unknown>;
    const syncUsers = cfg.syncUsers !== false;
    const autoProvision = cfg.autoProvisionUsers !== false;

    if (!syncUsers) {
      const reason = `syncUsers disabled on ${pluginKey} source`;
      logger.info('iam_provision_identity: JML joiner skipped', {
        jobId: String(job.id), tenantId, identityId, pluginKey, reason,
      });
      return { status: 'skipped', jobType: 'iam_provision_identity', reason };
    }
    if (!autoProvision) {
      const reason = `autoProvisionUsers disabled on ${pluginKey} source`;
      logger.info('iam_provision_identity: JML joiner skipped', {
        jobId: String(job.id), tenantId, identityId, pluginKey, reason,
      });
      return { status: 'skipped', jobType: 'iam_provision_identity', reason };
    }
  }

  const identityType = identity.type;
  const existingProviders = (identity.provisioning_providers_status as Record<string, unknown>) || {};

  // SHARED_CREDENTIAL doesn't need a Keycloak user account
  if (identityType === 'SHARED_CREDENTIAL') {
    await prisma.integration_identities.updateMany({
      where: { id: identityId },
      data: {
        provisioning_providers_status: {
          ...existingProviders,
          keycloak: {
            status: 'SKIPPED',
            reason: 'Shared credentials use platform-native auth, not Keycloak',
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      },
    });

    await reconcileProvisioningStatus(prisma, identityId);

    logger.info(
      'Dedicated identity Keycloak provisioning skipped (SHARED_CREDENTIAL)',
      { jobId: job.id, tenantId, identityId, identityType },
    );
    return { status: 'completed', jobType: 'iam_provision_identity' };
  }

  // HUMAN_INTERACTIVE and SERVICE_ACCOUNT: create Keycloak user
  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: tenantId },
  });
  const realm = (settings as any)?.keycloak_realm || tenantId;

  try {
    const keycloakUser = await createKeycloakUser({
      realm,
      username: identity.identifier,
      email: identity.identifier,
      firstName: identity.name?.split(' ')[0] || identity.identifier,
      lastName: identity.name?.split(' ').slice(1).join(' ') || '',
      enabled: true,
    });

    await prisma.integration_identities.updateMany({
      where: { id: identityId },
      data: {
        keycloak_user_id: keycloakUser.id,
        provisioning_providers_status: {
          ...existingProviders,
          keycloak: {
            status: 'PROVISIONED',
            externalId: keycloakUser.id,
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      },
    });

    await reconcileProvisioningStatus(prisma, identityId);

    logger.info(
      'Dedicated identity provisioned in Keycloak',
      { jobId: job.id, tenantId, identityId, keycloakUserId: keycloakUser.id },
    );
  } catch (err) {
    await prisma.integration_identities.updateMany({
      where: { id: identityId },
      data: {
        provisioning_status: 'ERROR',
        provisioning_error: (err as Error).message,
        provisioning_providers_status: {
          ...existingProviders,
          keycloak: {
            status: 'ERROR',
            error: (err as Error).message,
            updatedAt: new Date().toISOString(),
          },
        },
        updatedAt: new Date(),
      },
    });
    throw err;
  }

  return { status: 'completed', jobType: 'iam_provision_identity' };
}
