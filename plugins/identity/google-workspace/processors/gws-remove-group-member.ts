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
import {
  resolveProviderOverride,
  applyOverrideDelay,
} from '../../../../lib/http/provider-override-resolver.js';

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

  // E2E provider-response override hook — agency-scoped, non-prod gated.
  // Fail-closed: null override → real fetch proceeds.
  const override = await resolveProviderOverride(tenantId, 'gws', url);
  let res: Response;
  if (override) {
    await applyOverrideDelay(override);
    const bodyStr = override.body == null ? '' : typeof override.body === 'string' ? override.body : JSON.stringify(override.body);
    res = new Response(bodyStr, { status: override.status });
  } else {
    res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  // 204 No Content on success; 404 on already-gone; 409 defensive.
  if (res.ok || res.status === 404 || res.status === 409) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.removed',
      source: 'google-workspace', severity: 'info',
      actor: { id: null, type: 'system' },
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
