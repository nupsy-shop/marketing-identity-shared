/**
 * Entra ID Add Group Member — Plugin Processor
 *
 * Processes entra_add_group_member Bull jobs. Adds a user to a group
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

export default async function entraAddGroupMember(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();

  // Writeback flow — payload has localGroupId.
  if (job.data.localGroupId) {
    return handleWriteback(job);
  }

  // Legacy mover flow — payload has { tenantId, groupId, userId, email }.
  // Unchanged behavior — preserved from the prior implementation.
  const { tenantId, groupId, userId, email } = job.data;

  const source = await prisma.identity_sources.findFirst({
    where: { agency_id: tenantId, plugin_key: 'entra-id' },
  });
  if (!source) {
    logger.info('entra_add_group_member: no Entra ID source, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_add_group_member' };
  }

  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({ where: { id: source.oauth_token_id } });
    if (token && token.is_active !== false) accessToken = token.access_token;
  }
  if (!accessToken) throw new Error('No valid OAuth token for Entra ID — will retry');

  const { addMember } = await import('./api/graph.js');
  await addMember(accessToken, groupId, userId);

  logger.info('entra_add_group_member: member added to group (mover flow)', {
    jobId: String(job.id), groupId, userId, email,
  });
  return { status: 'completed', jobType: 'entra_add_group_member' };
}

async function handleWriteback(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId, localGroupId, userId, linkedGroupExternalId } = job.data as {
    tenantId: string; sourceId: string; localGroupId: string; userId: string; linkedGroupExternalId: string;
  };
  const jobId = String(job.id);

  const pre = await loadEntraGroupMemberContext({ tenantId, sourceId, userId, linkedGroupExternalId });
  if (pre.kind === 'skip') {
    logger.info('entra_add_group_member: writeback skipped', { jobId, reason: pre.reason });
    return { status: 'skipped', jobType: 'entra_add_group_member', reason: pre.reason };
  }
  const { entraUserId, accessToken } = pre.ctx;

  const url = `https://graph.microsoft.com/v1.0/groups/${linkedGroupExternalId}/members/$ref`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${entraUserId}`,
    }),
  });

  if (res.ok || res.status === 204) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.added',
      source: 'entra-id', severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'local_directory_groups', id: localGroupId },
      context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'entra-id', sourceId },
    }).catch(() => {});
    return { status: 'completed', jobType: 'entra_add_group_member' };
  }

  // Entra's "already a member" surfaces as 400 with a specific message.
  if (res.status === 400) {
    const body = await res.text().catch(() => '');
    if (body.includes('One or more added object references already exist')) {
      publishAuditEvent({
        eventType: 'directory.group.writeback.added',
        source: 'entra-id', severity: 'info',
        actor: { id: null, type: 'system' },
        agency: { id: tenantId },
        resource: { type: 'local_directory_groups', id: localGroupId },
        context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'entra-id', sourceId, alreadyMember: true },
      }).catch(() => {});
      return { status: 'completed', jobType: 'entra_add_group_member' };
    }
    throw new Error(`entra_add_group_member: HTTP 400 — ${body.slice(0, 200)}`);
  }

  if (res.status === 404) {
    const reason = 'upstream group or user deleted';
    logger.info('entra_add_group_member: writeback skipped', { jobId, reason });
    return { status: 'skipped', jobType: 'entra_add_group_member', reason };
  }

  if (res.status === 403) {
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: { connection_state: 'degraded', updated_at: new Date() },
    }).catch(() => {});
    throw new Error(`entra_add_group_member: insufficient scope (HTTP 403) — source marked degraded`);
  }

  throw new Error(`entra_add_group_member: HTTP ${res.status}`);
}
