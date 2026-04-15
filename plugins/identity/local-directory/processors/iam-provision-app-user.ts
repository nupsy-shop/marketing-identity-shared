/**
 * IAM Provision App User
 *
 * Creates a Keycloak user account for a local directory user.
 * Sets a temporary password with UPDATE_PASSWORD required action,
 * then updates local_directory_users with the Keycloak user ID.
 *
 * Payload:
 *   tenantId      — agency ID
 *   userId        — local_directory_users.id
 *   email         — user email (optional, falls back to DB)
 *   displayName   — display name (optional)
 *   givenName     — first name (optional)
 *   familyName    — last name (optional)
 *   tempPassword  — temporary password (optional, sends email if omitted)
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { createKeycloakUser, sendKeycloakActionsEmail, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function iamProvisionAppUser(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, userId, email, displayName, givenName, familyName, tempPassword } = job.data;

  if (!isKeycloakAdminConfigured()) {
    logger.warn({ jobId: job.id, tenantId }, 'Keycloak admin not configured, skipping');
    return { status: 'completed', jobType: 'iam_provision_app_user' };
  }

  if (!userId) {
    throw new Error('Missing required field: userId (local_directory_users.id)');
  }

  const user = await prisma.local_directory_users.findUnique({
    where: { id: userId },
  });

  if (!user) {
    logger.warn({ jobId: job.id, tenantId, userId }, 'Local directory user not found, skipping');
    return { status: 'completed', jobType: 'iam_provision_app_user' };
  }

  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: tenantId },
  });
  const realm = (settings as any)?.keycloak_realm || tenantId;

  try {
    const keycloakUser = await createKeycloakUser({
      realm,
      username: email || user.email,
      email: email || user.email,
      firstName: givenName || user.given_name || (displayName || user.display_name)?.split(' ')[0] || '',
      lastName: familyName || user.family_name || (displayName || user.display_name)?.split(' ').slice(1).join(' ') || '',
      enabled: true,
      ...(tempPassword
        ? {
            credentials: [{ type: 'password', value: tempPassword, temporary: true }],
            requiredActions: ['UPDATE_PASSWORD'],
          }
        : {}),
    });

    await prisma.local_directory_users.update({
      where: { id: userId },
      data: {
        keycloak_user_id: keycloakUser.id,
        keycloak_sub: keycloakUser.id,
        activation_status: 'provisioned',
        provisioned_at: new Date(),
        updated_at: new Date(),
      },
    });

    if (!tempPassword) {
      try {
        await sendKeycloakActionsEmail(realm, keycloakUser.id, ['UPDATE_PASSWORD']);
      } catch (emailErr) {
        logger.warn(
          { jobId: job.id, userId, err: (emailErr as Error).message },
          'Failed to send activation email — user created but needs manual password reset',
        );
      }
    }

    logger.info(
      { jobId: job.id, tenantId, userId, email: email || user.email, keycloakUserId: keycloakUser.id },
      'App user provisioned in Keycloak',
    );
  } catch (err) {
    await prisma.local_directory_users.update({
      where: { id: userId },
      data: { activation_status: 'error', updated_at: new Date() },
    });
    throw err;
  }

  return { status: 'completed', jobType: 'iam_provision_app_user' };
}
