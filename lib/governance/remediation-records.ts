/**
 * Database helpers for the `remediations` table.
 *
 * Extracted from `remediation-engine.ts` as part of issue #91 so the engine
 * can stay a thin orchestrator. All functions preserve agency scoping and
 * their original signatures/return shapes.
 */

import { getRuntime } from '../runtime.js';
import { Prisma } from '@prisma/client';
import { scrubSecrets } from './remediation-guards.js';
import type {
  ListFilters,
  MappedRemediation,
  RemediationContext,
  RemediationMode,
  RemediationRecord,
} from './remediation-types.js';

/**
 * Create a pending remediation row, capturing before-state so revert is
 * possible later. Secrets are scrubbed from both `context` and
 * `before_state` before persistence (defence-in-depth — producers shouldn't
 * pass them in, but we don't rely on that).
 */
export async function createRemediationRecord(
  agencyId: string,
  triggerType: string,
  context: RemediationContext,
  mode: RemediationMode,
): Promise<RemediationRecord> {
  const beforeState = await captureBeforeState(context);

  const safeContext = scrubSecrets(context as unknown as Record<string, unknown>);
  const safeBeforeState = scrubSecrets(beforeState);

  return (await getRuntime().prisma.remediations.create({
    data: {
      agency_id: agencyId,
      trigger_type: triggerType,
      mode,
      status: 'pending',
      target_user_id: (context.userId || context.targetUserId || null) as string | null,
      target_platform: (context.platformKey || null) as string | null,
      context: safeContext as Prisma.InputJsonValue,
      before_state: (safeBeforeState ?? Prisma.JsonNull) as Prisma.InputJsonValue,
    },
  })) as unknown as RemediationRecord;
}

/**
 * Snapshot the subset of state we need to revert an action later. Pure —
 * reads from Prisma only (agency-scoped via `access_request_items` rows).
 */
export async function captureBeforeState(
  context: RemediationContext,
): Promise<Record<string, unknown>> {
  const beforeState: Record<string, unknown> = {};
  if (context.accessRequestItemIds?.length) {
    const itemResult = (await getRuntime().prisma.access_request_items.findMany({
      where: { id: { in: context.accessRequestItemIds } },
      select: { id: true, status: true },
    })) as Array<{ id: string; status: string }>;
    beforeState.accessRequestItemIds = itemResult.map((r) => r.id);
    beforeState.previousStatuses = itemResult.map((r) => r.status);
  }
  if (context.userId) beforeState.userId = context.userId;
  if (context.userEmail) beforeState.userEmail = context.userEmail;
  if (context.platformKey) beforeState.platformKey = context.platformKey;
  return beforeState;
}

export async function updateRemediationStatus(
  id: string,
  status: string,
  result: Record<string, unknown> | null = null,
): Promise<void> {
  const data: Record<string, unknown> = { status, updated_at: new Date() };
  if (result) data.result = result;
  if (status === 'completed' || status === 'failed') {
    data.executed_at = new Date();
  }
  await getRuntime().prisma.remediations.update({ where: { id }, data });
}

export async function listRemediations(
  agencyId: string,
  filters: ListFilters = {},
): Promise<MappedRemediation[]> {
  const where: Record<string, unknown> = { agency_id: agencyId };
  if (filters.triggerType) where.trigger_type = filters.triggerType;
  if (filters.status) where.status = filters.status;

  const rows = await getRuntime().prisma.remediations.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: filters.limit || 50,
    skip: filters.offset || 0,
  });
  return rows.map(mapRemediationRow);
}

export async function getRemediationById(
  id: string,
): Promise<MappedRemediation | null> {
  const row = await getRuntime().prisma.remediations.findUnique({ where: { id } });
  return row ? mapRemediationRow(row) : null;
}

export function mapRemediationRow(row: Record<string, unknown>): MappedRemediation {
  return {
    id: row.id as string,
    agencyId: row.agency_id as string,
    triggerType: row.trigger_type as string,
    mode: row.mode as string,
    status: row.status as string,
    targetUserId: (row.target_user_id as string | null) || null,
    targetPlatform: (row.target_platform as string | null) || null,
    context: (row.context as Record<string, unknown>) || {},
    beforeState: (row.before_state as Record<string, unknown>) || {},
    result: (row.result as Record<string, unknown>) || {},
    workflowInstanceId: (row.workflow_instance_id as string | null) || null,
    scheduledAt: (row.scheduled_at as Date | null) || null,
    executedAt: (row.executed_at as Date | null) || null,
    revertedAt: (row.reverted_at as Date | null) || null,
    revertDeadline: (row.revert_deadline as Date | null) || null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}
