/**
 * IAM Deprovision App User
 *
 * Deletes a Keycloak user account for a local directory user.
 * Removes the user from Keycloak and clears keycloak_user_id.
 *
 * Payload:
 *   tenantId  — agency ID
 *   userId    — local_directory_users.id
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { adminFetch, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function iamDeprovisionAppUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, userId } = job.data;

  if (!isKeycloakAdminConfigured()) {
    logger.warn('Keycloak admin not configured, skipping', { jobId: job.id, tenantId });
    return { status: 'completed', jobType: 'iam_deprovision_app_user' };
  }

  if (!userId) {
    throw new Error('Missing required field: userId');
  }

  const user = await prisma.local_directory_users.findUnique({
    where: { id: userId },
  });

  if (!user) {
    logger.warn('Local directory user not found, skipping', { jobId: job.id, tenantId, userId });
    return { status: 'completed', jobType: 'iam_deprovision_app_user' };
  }

  if (user.keycloak_user_id) {
    const settings = await prisma.agency_settings.findUnique({
      where: { agency_id: tenantId },
    });
    const realm = (settings as any)?.keycloak_realm || tenantId;

    if (isKeycloakAdminConfigured()) {
      const res = await adminFetch(realm, `/users/${user.keycloak_user_id}`, {
        method: 'DELETE',
      });

      // 204 = deleted, 404 = already gone — both are fine
      if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`Failed to delete Keycloak user (${res.status}): ${text}`);
      }
    }
  }

  await prisma.local_directory_users.update({
    where: { id: userId },
    data: {
      keycloak_user_id: null,
      keycloak_sub: null,
      activation_status: 'deprovisioned',
      is_active: false,
      updated_at: new Date(),
    },
  });

  logger.info(
    'App user deprovisioned from Keycloak',
    { jobId: job.id, tenantId, userId, keycloakUserId: user.keycloak_user_id },
  );

  return { status: 'completed', jobType: 'iam_deprovision_app_user' };
}
