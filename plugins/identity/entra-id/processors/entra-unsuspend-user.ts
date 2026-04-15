/**
 * Entra ID Unsuspend User — Plugin Processor
 *
 * Processes entra_unsuspend_user Bull jobs. Re-enables a user in Entra ID
 * by setting accountEnabled = true via Microsoft Graph API.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function entraUnsuspendUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, entraUserId, email } = job.data;
  const { prisma, logger } = getRuntime();

  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'entra-id',
    },
  });

  if (!source) {
    logger.info('entra_unsuspend_user: no Entra ID source, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_unsuspend_user' };
  }

  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({
      where: { id: source.oauth_token_id },
    });
    if (token && token.is_active !== false) {
      accessToken = token.access_token;
    }
  }

  if (!accessToken) {
    throw new Error('No valid OAuth token for Entra ID — will retry');
  }

  const { updateUser } = await import('./api/graph.js');
  await updateUser(accessToken, entraUserId, { accountEnabled: true });

  logger.info('entra_unsuspend_user: user re-enabled in Entra ID', {
    jobId: String(job.id), entraUserId, email,
  });

  return { status: 'completed', jobType: 'entra_unsuspend_user' };
}
