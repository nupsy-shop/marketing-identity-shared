import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { adminFetch, mergeUserAttributes, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function keycloakUpdateUser(job: Bull.Job): Promise<JobResult> {
  const { logger } = getRuntime();
  const { tenantId, realm, keycloakUserId, updates, attributes } = job.data;

  if (!isKeycloakAdminConfigured()) {
    logger.warn('Keycloak admin not configured, skipping update', { jobId: job.id, tenantId });
    return { status: 'completed', jobType: 'iam_update_identity' };
  }

  if (!realm || !keycloakUserId) {
    throw new Error('Missing required fields: realm, keycloakUserId');
  }

  // Update user properties if provided
  if (updates && Object.keys(updates).length > 0) {
    const res = await adminFetch(realm, `/users/${keycloakUserId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Failed to update Keycloak user (${res.status}): ${text}`);
    }
  }

  // Merge attributes if provided
  if (attributes && Object.keys(attributes).length > 0) {
    await mergeUserAttributes(keycloakUserId, attributes, realm);
  }

  logger.info('Keycloak user updated', { jobId: job.id, tenantId, keycloakUserId });
  return { status: 'completed', jobType: 'iam_update_identity' };
}
