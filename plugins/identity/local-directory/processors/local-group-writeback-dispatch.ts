/**
 * Local Group Writeback Dispatch — Plugin Processor
 *
 * Processes local_group_writeback_dispatch Bull jobs. Fans out a
 * local-directory group-membership change to the per-plugin write job
 * for the linked identity source.
 *
 * Runs six precondition checks in order; on any failure returns
 * { status: 'skipped', reason } so the Jobs Dashboard renders the
 * standard Skipped pill + reason block (matches jml_detect_lifecycle
 * convention).
 *
 * Never calls the provider directly. Never imports plugin code.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: 'local_group_writeback_dispatch';
  reason?: string;
  dispatched?: string;
}

interface DispatchPayload {
  tenantId: string;
  localGroupId: string;
  userId: string;
  action: 'add' | 'remove';
  triggeredBy?: string;
}

const JOB_NAME_MAP: Record<string, Record<'add' | 'remove', string>> = {
  'google-workspace': { add: 'gws_add_group_member', remove: 'gws_remove_group_member' },
  'entra-id': { add: 'entra_add_group_member', remove: 'entra_remove_group_member' },
};

function skipped(reason: string, logger: { info(msg: string, ctx?: Record<string, unknown>): void }, jobId: string, ctx: Record<string, unknown>): JobResult {
  logger.info('local_group_writeback_dispatch: skipped', { jobId, reason, ...ctx });
  return { status: 'skipped', jobType: 'local_group_writeback_dispatch', reason };
}

export default async function localGroupWritebackDispatch(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger, enqueueJob } = getRuntime();
  const { tenantId, localGroupId, userId, action } = job.data as DispatchPayload;
  const jobId = String(job.id);

  const localGroup = await prisma.local_directory_groups.findFirst({
    where: { id: localGroupId, agency_id: tenantId },
    select: {
      id: true, agency_id: true,
      linked_source_id: true, linked_directory_group_id: true,
    },
  });
  if (!localGroup) {
    return skipped('local group not found', logger, jobId, { localGroupId });
  }
  if (!localGroup.linked_source_id || !localGroup.linked_directory_group_id) {
    return skipped('group no longer linked', logger, jobId, { localGroupId });
  }

  const source = await prisma.identity_sources.findFirst({
    where: { id: localGroup.linked_source_id, agency_id: tenantId },
    select: { id: true, display_name: true, plugin_key: true, connection_state: true, connection_config: true },
  });
  if (!source) {
    return skipped('linked source not found', logger, jobId, { sourceId: localGroup.linked_source_id });
  }
  if (source.connection_state === 'disconnected') {
    return skipped(`linked source disconnected (${source.display_name ?? source.plugin_key})`, logger, jobId, { sourceId: source.id });
  }

  const cfg = (source.connection_config ?? {}) as Record<string, unknown>;
  if (cfg.groupWriteBack !== true) {
    return skipped(`writeback disabled on source ${source.display_name ?? source.plugin_key}`, logger, jobId, { sourceId: source.id });
  }

  const pluginMap = JOB_NAME_MAP[source.plugin_key];
  if (!pluginMap) {
    return skipped(`writeback not supported for plugin ${source.plugin_key}`, logger, jobId, { pluginKey: source.plugin_key });
  }
  const downstreamJob = pluginMap[action];
  if (!downstreamJob) {
    return skipped(`unknown action "${action}"`, logger, jobId, {});
  }

  if (!enqueueJob) {
    return skipped('enqueueJob not provided by runtime', logger, jobId, {});
  }

  await enqueueJob(downstreamJob, {
    tenantId,
    sourceId: source.id,
    localGroupId: localGroup.id,
    userId,
    linkedGroupExternalId: localGroup.linked_directory_group_id,
  });

  logger.info('local_group_writeback_dispatch: dispatched', {
    jobId, localGroupId, sourceId: source.id, pluginKey: source.plugin_key, action, downstreamJob,
  });

  return { status: 'completed', jobType: 'local_group_writeback_dispatch', dispatched: downstreamJob };
}
