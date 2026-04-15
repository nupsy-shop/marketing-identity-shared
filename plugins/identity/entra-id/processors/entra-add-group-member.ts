/**
 * Entra ID Add Group Member — Plugin Processor
 *
 * Processes entra_add_group_member Bull jobs. Adds a user to a group
 * in Entra ID via Microsoft Graph API.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function entraAddGroupMember(job: Bull.Job): Promise<JobResult> {
  const { tenantId, groupId, userId, email } = job.data;
  const { prisma, logger } = getRuntime();

  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'entra-id',
    },
  });

  if (!source) {
    logger.info('entra_add_group_member: no Entra ID source, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_add_group_member' };
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

  const { addMember } = await import('./api/graph.js');
  await addMember(accessToken, groupId, userId);

  logger.info('entra_add_group_member: member added to group', {
    jobId: String(job.id), groupId, userId, email,
  });

  return { status: 'completed', jobType: 'entra_add_group_member' };
}
