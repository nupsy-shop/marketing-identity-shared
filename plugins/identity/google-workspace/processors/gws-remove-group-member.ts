/**
 * GWS Remove Group Member — Plugin Processor
 *
 * Writeback: removes a user from a Google Workspace group via the Admin
 * SDK. Mirror of gws_add_group_member.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import { loadGwsGroupMemberContext } from './_group-member-preconditions.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: 'gws_remove_group_member';
  reason?: string;
}

export default async function gwsRemoveGroupMember(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId, localGroupId, userId, linkedGroupExternalId } = job.data as {
    tenantId: string; sourceId: string; localGroupId: string; userId: string; linkedGroupExternalId: string;
  };
  const jobId = String(job.id);

  const pre = await loadGwsGroupMemberContext({ tenantId, sourceId, userId, linkedGroupExternalId });
  if (pre.kind === 'skip') {
    logger.info('gws_remove_group_member: skipped', { jobId, reason: pre.reason });
    return { status: 'skipped', jobType: 'gws_remove_group_member', reason: pre.reason };
  }
  const { userEmail, groupEmail, accessToken } = pre.ctx;

  const url = `https://admin.googleapis.com/admin/directory/v1/groups/${groupEmail}/members/${userEmail}`;
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // 204 No Content on success; 404 on already-gone; 409 defensive.
  if (res.ok || res.status === 404 || res.status === 409) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.removed',
      source: 'google-workspace', severity: 'info',
      actor: { type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'local_directory_groups', id: localGroupId },
      context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'google-workspace', sourceId },
    }).catch(() => {});
    return { status: 'completed', jobType: 'gws_remove_group_member' };
  }

  if (res.status === 403) {
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: { connection_state: 'degraded', updated_at: new Date() },
    }).catch(() => {});
    throw new Error(`gws_remove_group_member: insufficient scope (HTTP 403) — source marked degraded`);
  }

  throw new Error(`gws_remove_group_member: HTTP ${res.status}`);
}
