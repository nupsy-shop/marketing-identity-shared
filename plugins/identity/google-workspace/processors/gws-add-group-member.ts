/**
 * GWS Add Group Member — Plugin Processor
 *
 * Writeback: adds a user to a Google Workspace group via the Admin SDK.
 * Triggered from local_group_writeback_dispatch when a linked local
 * group gains a member. Skips-with-reason on every operator-controllable
 * precondition; treats 409 as idempotent success and 404 as
 * upstream-deleted skip.
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
  jobType: 'gws_add_group_member';
  reason?: string;
}

export default async function gwsAddGroupMember(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, sourceId, localGroupId, userId, linkedGroupExternalId } = job.data as {
    tenantId: string; sourceId: string; localGroupId: string; userId: string; linkedGroupExternalId: string;
  };
  const jobId = String(job.id);

  const pre = await loadGwsGroupMemberContext({ tenantId, sourceId, userId, linkedGroupExternalId });
  if (pre.kind === 'skip') {
    logger.info('gws_add_group_member: skipped', { jobId, reason: pre.reason });
    return { status: 'skipped', jobType: 'gws_add_group_member', reason: pre.reason };
  }
  const { userEmail, groupEmail, accessToken } = pre.ctx;

  const url = `https://admin.googleapis.com/admin/directory/v1/groups/${groupEmail}/members`;

  // E2E provider-response override hook — agency-scoped, non-prod gated.
  // Short-circuits with a synthetic Response so the live status-handling
  // branches below (409 idempotent, 404 upstream-deleted, 403 degrade, etc.)
  // still run unchanged. Fail-closed: null override → real fetch proceeds.
  const override = await resolveProviderOverride(tenantId, 'gws', url);
  let res: Response;
  if (override) {
    await applyOverrideDelay(override);
    const bodyStr = override.body == null ? '' : typeof override.body === 'string' ? override.body : JSON.stringify(override.body);
    res = new Response(bodyStr, { status: override.status });
  } else {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: userEmail, role: 'MEMBER' }),
    });
  }

  if (res.ok) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.added',
      source: 'google-workspace', severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'local_directory_groups', id: localGroupId },
      context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'google-workspace', sourceId },
    }).catch(() => {});
    return { status: 'completed', jobType: 'gws_add_group_member' };
  }

  if (res.status === 409) {
    publishAuditEvent({
      eventType: 'directory.group.writeback.added',
      source: 'google-workspace', severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'local_directory_groups', id: localGroupId },
      context: { localGroupId, userId, linkedGroupExternalId, pluginKey: 'google-workspace', sourceId, alreadyMember: true },
    }).catch(() => {});
    return { status: 'completed', jobType: 'gws_add_group_member' };
  }

  if (res.status === 404) {
    const reason = 'upstream group or user deleted';
    logger.info('gws_add_group_member: skipped', { jobId, reason });
    return { status: 'skipped', jobType: 'gws_add_group_member', reason };
  }

  if (res.status === 403) {
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: { connection_state: 'degraded', updated_at: new Date() },
    }).catch(() => {});
    throw new Error(`gws_add_group_member: insufficient scope (HTTP 403) — source marked degraded`);
  }

  throw new Error(`gws_add_group_member: HTTP ${res.status}`);
}
