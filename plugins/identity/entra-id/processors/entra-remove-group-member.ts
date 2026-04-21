/**
 * Entra ID Remove Group Member — Plugin Processor
 *
 * Processes entra_remove_group_member Bull jobs. Removes a user from a group
 * in Entra ID via Microsoft Graph API.
 *
 * Two flows dispatched by payload shape:
 *   - Writeback flow: payload has `localGroupId` (from local_group_writeback_dispatch)
 *   - Legacy mover flow: payload has `{ tenantId, groupId, userId, email }` (unchanged)
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import { loadEntraGroupMemberContext } from './_group-member-preconditions.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: string;
  reason?: string;
}

export default async function entraRemoveGroupMember(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();

  // Writeback flow — payload has localGroupId.
  if (job.data.localGroupId) {
    return handleRemoveWriteback(job);
  }

  // Legacy mover flow — payload has { tenantId, groupId, userId, email }.
  // Unchanged behavior — preserved from the prior implementation.
  const { tenantId, groupId, userId, email } = job.data;

  const source = await prisma.identity_sources.findFirst({
    where: { agency_id: tenantId, plugin_key: 'entra-id' },
  });
  if (!source) {
    logger.info('entra_remove_group_member: no Entra ID source, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_remove_group_member' };
  }

  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({ where: { id: source.oauth_token_id } });
    if (token && token.is_active !== false) accessToken = token.access_token;
  }
  if (!accessToken) throw new Error('No valid OAuth token for Entra ID — will retry');

  const { removeMember } = await import('./api/graph.js');
  await removeMember(accessToken, groupId, userId);

  logger.info('entra_remove_group_member: member removed from group (mover flow)', {
    jobId: String(job.id), groupId, userId, email,
  });
  return { status: 'completed', jobType: 'entra_remove_group_member' };
}

async function handleRemoveWriteback(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId, localGroupId, userId, linkedGroupExternalId } = job.data as {
    tenantId: string; sourceId: string; localGroupId: string; userId: string; linkedGroupExternalId: string;
  };
  const jobId = String(job.id);

  const pre = await loadEntraGroupMemberContext({ tenantId, sourceId, userId, linkedGroupExternalId });
  if (pre.kind === 'skip') {
    logger.info('entra_remove_group_member: writeback skipped', { jobId, reason: pre.reason });
    return { status: 'skipped', jobType: 'entra_remove_group_member', reason: pre.reason };
  }
  const { entraUserId, accessToken } = pre.ctx;

  const url = `https://graph.microsoft.com/v1.0/groups/${linkedGroupExternalId}/members/${entraUserId}/$ref`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.ok || res.status === 204 || res.status === 404) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.removed',
      source: 'entra-id', severity: 'info',
      actor: { type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'local_directory_groups', id: localGroupId },
      context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'entra-id', sourceId },
    }).catch(() => {});
    return { status: 'completed', jobType: 'entra_remove_group_member' };
  }

  if (res.status === 403) {
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: { connection_state: 'degraded', updated_at: new Date() },
    }).catch(() => {});
    throw new Error(`entra_remove_group_member: insufficient scope (HTTP 403) — source marked degraded`);
  }

  throw new Error(`entra_remove_group_member: HTTP ${res.status}`);
}
