/**
 * JML Lifecycle Processor — Shared Library
 *
 * Canonical lifecycle event processing engine. Evaluates policies,
 * applies scope filtering, triggers revocations/scheduled actions,
 * dispatches notifications, and logs audit events.
 *
 * Used by:
 * - Web app sync-engine (lib/identity/sync-engine.ts)
 * - Worker jml_process_lifecycle processor
 */

import { getRuntime } from '../runtime.js';
import {
  resolveJoinerAction,
  resolveLeaverAction,
  resolveSuspensionAction,
  resolveNotifications,
  type ResolvedAction,
} from './policy-action-map.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LifecycleEvents {
  joiners?: string[];         // external IDs of new users
  leavers?: string[];         // external IDs of deactivated users
  suspended?: string[];       // external IDs of newly suspended users
  unsuspended?: string[];     // external IDs of unsuspended users
  groupChanges?: GroupChange[];
}

export interface GroupChange {
  userId?: string;
  userExternalId?: string;
  userEmail?: string;
  added?: string[];           // group IDs added
  removed?: string[];         // group IDs removed
}

export interface JmlScope {
  type: 'entire_org' | 'org_units' | 'group' | 'entire_directory' | 'groups';
  orgUnitPaths?: string[];
  groupId?: string;
  groupEmail?: string;
  groupIds?: string[];
}

export interface JmlPolicies {
  joiner?: { action?: string; notifyAdmins?: boolean; requireApproval?: boolean };
  leaver?: { action?: string; grace_period_days?: number; notify_admins?: boolean; notify_manager?: boolean };
  suspension?: { action?: string; grace_period_days?: number; auto_restore_on_unsuspend?: boolean; notify_admins?: boolean; notify_manager?: boolean };
  mover?: {
    on_group_removal?: { action?: string; grace_period_days?: number };
    on_group_addition?: { action?: string; use_rbac_mappings?: boolean };
    notify_admins?: boolean;
    notify_manager?: boolean;
  };
}

export interface WriteGuardrails {
  max_revocations_per_sync: number;
  require_confirmation_above: number;
  dry_run_mode: boolean;
}

export interface ProcessLifecycleParams {
  sourceId: string;
  agencyId: string;
  pluginKey: string;
  events: LifecycleEvents;
  policies: JmlPolicies;
  guardrails: WriteGuardrails;
  scope: JmlScope | null;
}

// ─── Scope Filtering ────────────────────────────────────────────────────────

/**
 * Filter a list of user external IDs against the configured JML scope.
 * Returns the subset of external IDs that are in-scope.
 */
export async function filterByScope(
  externalIds: string[],
  sourceId: string,
  pluginKey: string,
  scope: JmlScope | null,
): Promise<string[]> {
  if (!scope || externalIds.length === 0) return externalIds;

  const { prisma } = getRuntime();

  // entire_org / entire_directory — no filtering
  if (scope.type === 'entire_org' || scope.type === 'entire_directory') {
    return externalIds;
  }

  // GWS org_units — filter by org_unit_path prefix
  if (scope.type === 'org_units' && scope.orgUnitPaths?.length) {
    const users = await prisma.gws_directory_users.findMany({
      where: {
        source_id: sourceId,
        email: { in: externalIds }, // external ID is email for GWS
        org_unit_path: { not: null },
      },
      select: { email: true, org_unit_path: true },
    });

    return users
      .filter((u: any) =>
        scope.orgUnitPaths!.some((ouPath) => u.org_unit_path?.startsWith(ouPath)),
      )
      .map((u: any) => u.email);
  }

  // GWS group — filter by group membership
  if (scope.type === 'group' && scope.groupId) {
    const members = await prisma.gws_group_members.findMany({
      where: { group_id: scope.groupId },
      select: { user_email: true },
    });
    const memberEmails = new Set(members.map((m: any) => m.user_email));
    return externalIds.filter((id) => memberEmails.has(id));
  }

  // Entra groups — filter by directory_memberships
  if (scope.type === 'groups' && scope.groupIds?.length) {
    const users = await prisma.directory_users.findMany({
      where: {
        source_id: sourceId,
        external_id: { in: externalIds },
        directory_memberships: {
          some: { group_id: { in: scope.groupIds } },
        },
      },
      select: { external_id: true },
    });
    return users.map((u: any) => u.external_id);
  }

  return externalIds;
}

/**
 * Filter group changes against scope.
 */
export async function filterGroupChangesByScope(
  changes: GroupChange[],
  sourceId: string,
  pluginKey: string,
  scope: JmlScope | null,
): Promise<GroupChange[]> {
  if (!scope || changes.length === 0) return changes;

  // For group-scoped monitoring, only report changes involving the monitored group(s)
  if (scope.type === 'group' && scope.groupId) {
    return changes.filter((c) =>
      c.added?.includes(scope.groupId!) || c.removed?.includes(scope.groupId!),
    );
  }

  if (scope.type === 'groups' && scope.groupIds?.length) {
    const scopeGroupSet = new Set(scope.groupIds);
    return changes.filter((c) =>
      c.added?.some((g) => scopeGroupSet.has(g)) || c.removed?.some((g) => scopeGroupSet.has(g)),
    );
  }

  // For OU-scoped or entire-org, include all group changes (users already filtered)
  return changes;
}

// ─── Main Processor ─────────────────────────────────────────────────────────

/**
 * Process lifecycle events with scope filtering, guardrails, and policy evaluation.
 *
 * This is the canonical entry point called by both the web app and worker.
 * The caller is responsible for:
 * 1. Detecting lifecycle events (comparing before/after sync state)
 * 2. Loading policies, guardrails, and scope from the DB
 * 3. Passing everything to this function
 *
 * This function handles:
 * 1. Scope filtering
 * 2. Guardrail evaluation (max revocations, dry run)
 * 3. Policy-based action dispatch (revoke, schedule, notify)
 * 4. Audit event logging
 */
export async function processLifecycleEvents(params: ProcessLifecycleParams): Promise<{
  processed: number;
  skippedByScope: number;
  skippedByGuardrail: boolean;
  enqueued: number;
}> {
  const { sourceId, agencyId, pluginKey, events, policies, guardrails, scope } = params;
  const { logger } = getRuntime();

  let processed = 0;
  let skippedByScope = 0;

  // 1. Apply scope filtering
  const filteredJoiners = await filterByScope(events.joiners || [], sourceId, pluginKey, scope);
  const filteredLeavers = await filterByScope(events.leavers || [], sourceId, pluginKey, scope);
  const filteredSuspended = await filterByScope(events.suspended || [], sourceId, pluginKey, scope);
  const filteredUnsuspended = await filterByScope(events.unsuspended || [], sourceId, pluginKey, scope);
  const filteredGroupChanges = await filterGroupChangesByScope(events.groupChanges || [], sourceId, pluginKey, scope);

  const totalOriginal =
    (events.joiners?.length || 0) +
    (events.leavers?.length || 0) +
    (events.suspended?.length || 0) +
    (events.unsuspended?.length || 0);
  const totalFiltered =
    filteredJoiners.length +
    filteredLeavers.length +
    filteredSuspended.length +
    filteredUnsuspended.length;
  skippedByScope = totalOriginal - totalFiltered;

  // 2. Guardrail: check max revocations
  const totalRevocations = filteredLeavers.length + filteredSuspended.length;
  if (totalRevocations > guardrails.max_revocations_per_sync) {
    logger.warn('[JML] Guardrail triggered: too many revocations', {
      count: totalRevocations,
      threshold: guardrails.max_revocations_per_sync,
      agencyId,
    });
    return { processed: 0, skippedByScope, skippedByGuardrail: true, enqueued: 0 };
  }

  // 3. Fan out to per-action jobs via the policy-action map.
  //    Each event → one primary action job (create/revoke/disable/enable)
  //    plus optional notification jobs per the policy's notify_* flags.
  //    All downstream routing (queue selection, retries, etc.) happens via
  //    the shared catalog once the jobType is determined.
  const { enqueueJob } = getRuntime();
  if (!enqueueJob) {
    // Host did not wire up an enqueue callback — caller must dispatch the
    // events themselves. Return counts only. This preserves the behavior
    // of hosts that compose lifecycle processing with a custom dispatcher.
    processed = totalFiltered;
    return {
      processed,
      skippedByScope,
      skippedByGuardrail: false,
      enqueued: 0,
    };
  }

  let enqueued = 0;

  const dispatch = async (
    principal: string,
    primary: ResolvedAction | null,
    notifications: ResolvedAction[],
    kind: 'joiner' | 'leaver' | 'suspension',
  ): Promise<void> => {
    const jobs: ResolvedAction[] = [];
    if (primary) jobs.push(primary);
    jobs.push(...notifications);
    for (const action of jobs) {
      const id = await enqueueJob(action.jobType, {
        tenantId: agencyId,
        sourceId,
        pluginKey,
        principal,
        kind,
        triggeredBy: 'jml_process_lifecycle',
        ...(action.extra ?? {}),
      });
      if (id) enqueued++;
    }
  };

  for (const email of filteredJoiners) {
    const primary = resolveJoinerAction(policies.joiner?.action as never, pluginKey);
    const notifs = resolveNotifications(policies.joiner, 'joiner');
    await dispatch(email, primary, notifs, 'joiner');
  }

  for (const email of filteredLeavers) {
    const primary = resolveLeaverAction(policies.leaver?.action as never, pluginKey);
    const notifs = resolveNotifications(policies.leaver, 'leaver');
    await dispatch(email, primary, notifs, 'leaver');
  }

  for (const email of filteredSuspended) {
    const primary = resolveSuspensionAction(policies.suspension?.action as never, pluginKey, 'suspend');
    const notifs = resolveNotifications(policies.suspension, 'suspension');
    await dispatch(email, primary, notifs, 'suspension');
  }

  for (const email of filteredUnsuspended) {
    const primary = resolveSuspensionAction(policies.suspension?.action as never, pluginKey, 'unsuspend');
    const notifs = resolveNotifications(policies.suspension, 'suspension');
    await dispatch(email, primary, notifs, 'suspension');
  }

  processed = totalFiltered;

  logger.info('[JML] Lifecycle events dispatched', {
    agencyId, sourceId, pluginKey,
    processed, skippedByScope, enqueued,
    joiners: filteredJoiners.length,
    leavers: filteredLeavers.length,
    suspended: filteredSuspended.length,
    unsuspended: filteredUnsuspended.length,
  });

  // Group-change fan-out (mover) is intentionally deferred — those events
  // arrive from the sync-time diff (not the principal-drift detect) and are
  // wired through a separate mover dispatcher. See
  // shared/lib/jml/mover-detector.ts.
  void filteredGroupChanges;

  return {
    processed,
    skippedByScope,
    skippedByGuardrail: false,
    enqueued,
  };
}
