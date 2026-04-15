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
  status: 'completed';
  jobType: string;
}

export default async function keycloakCreateUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, identityId } = job.data;

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

  const identityType = identity.type;
  const existingProviders = (identity.provisioning_providers_status as Record<string, unknown>) || {};

  // SHARED_CREDENTIAL doesn't need a Keycloak user account
  if (identityType === 'SHARED_CREDENTIAL') {
    await prisma.integration_identities.update({
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

    await prisma.integration_identities.update({
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
    await prisma.integration_identities.update({
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
