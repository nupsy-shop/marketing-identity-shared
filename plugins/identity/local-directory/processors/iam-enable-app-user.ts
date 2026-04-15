/**
 * IAM Enable App User
 *
 * Re-enables a previously disabled Keycloak user account.
 * Sets enabled=true in Keycloak and updates activation_status to 'provisioned'.
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

export default async function iamEnableAppUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, userId } = job.data;

  if (!isKeycloakAdminConfigured()) {
    logger.warn('Keycloak admin not configured, skipping', { jobId: job.id, tenantId });
    return { status: 'completed', jobType: 'iam_enable_app_user' };
  }

  if (!userId) {
    throw new Error('Missing required field: userId');
  }

  const user = await prisma.local_directory_users.findUnique({
    where: { id: userId },
  });

  if (!user) {
    logger.warn('Local directory user not found, skipping', { jobId: job.id, tenantId, userId });
    return { status: 'completed', jobType: 'iam_enable_app_user' };
  }

  if (!user.keycloak_user_id) {
    logger.warn('User has no keycloak_user_id, skipping', { jobId: job.id, tenantId, userId });
    return { status: 'completed', jobType: 'iam_enable_app_user' };
  }

  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: tenantId },
  });
  const realm = (settings as any)?.keycloak_realm || tenantId;

  const res = await adminFetch(realm, `/users/${user.keycloak_user_id}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled: true }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to enable Keycloak user (${res.status}): ${text}`);
  }

  await prisma.local_directory_users.update({
    where: { id: userId },
    data: {
      activation_status: 'provisioned',
      is_suspended: false,
      updated_at: new Date(),
    },
  });

  logger.info(
    'App user re-enabled in Keycloak',
    { jobId: job.id, tenantId, userId, keycloakUserId: user.keycloak_user_id },
  );

  return { status: 'completed', jobType: 'iam_enable_app_user' };
}
