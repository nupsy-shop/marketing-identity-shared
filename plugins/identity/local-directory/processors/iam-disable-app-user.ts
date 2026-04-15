/**
 * IAM Disable App User
 *
 * Disables a Keycloak user account for a local directory user.
 * Sets enabled=false in Keycloak and updates activation_status to 'suspended'.
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

export default async function iamDisableAppUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, userId } = job.data;

  if (!isKeycloakAdminConfigured()) {
    logger.warn({ jobId: job.id, tenantId }, 'Keycloak admin not configured, skipping');
    return { status: 'completed', jobType: 'iam_disable_app_user' };
  }

  if (!userId) {
    throw new Error('Missing required field: userId');
  }

  const user = await prisma.local_directory_users.findUnique({
    where: { id: userId },
  });

  if (!user) {
    logger.warn({ jobId: job.id, tenantId, userId }, 'Local directory user not found, skipping');
    return { status: 'completed', jobType: 'iam_disable_app_user' };
  }

  if (!user.keycloak_user_id) {
    logger.warn({ jobId: job.id, tenantId, userId }, 'User has no keycloak_user_id, skipping');
    return { status: 'completed', jobType: 'iam_disable_app_user' };
  }

  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: tenantId },
  });
  const realm = (settings as any)?.keycloak_realm || tenantId;

  const res = await adminFetch(realm, `/users/${user.keycloak_user_id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: false }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to disable Keycloak user (${res.status}): ${text}`);
  }

  await prisma.local_directory_users.update({
    where: { id: userId },
    data: {
      activation_status: 'suspended',
      is_suspended: true,
      updated_at: new Date(),
    },
  });

  logger.info(
    { jobId: job.id, tenantId, userId, keycloakUserId: user.keycloak_user_id },
    'App user disabled in Keycloak',
  );

  return { status: 'completed', jobType: 'iam_disable_app_user' };
}
