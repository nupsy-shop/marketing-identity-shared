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
import { dispatchNotification } from '../notifications/dispatch.js';
import {
  resolveJoinerAction,
  resolveLeaverAction,
  resolveSuspensionAction,
  resolveMoverGroupAction,
  resolveMoverAttributeAction,
  isDeferredAction,
  type ResolvedAction,
} from './policy-action-map.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LifecycleEvents {
  joiners?: string[];         // external IDs of new users
  leavers?: string[];         // external IDs of deactivated users
  suspended?: string[];       // external IDs of newly suspended users
  unsuspended?: string[];     // external IDs of unsuspended users
  groupChanges?: GroupChange[];
  attributeChanges?: AttributeChange[];
}

export interface GroupChange {
  userId?: string;
  userExternalId?: string;
  userEmail?: string;
  added?: string[];           // group IDs added
  removed?: string[];         // group IDs removed
}

/**
 * Per-user attribute diff captured by the sync processor during upsert.
 * Mover events (dept/title changes) fan out through `policies.mover` in
 * the downstream `jml_process_lifecycle` cascade.
 */
export interface AttributeChange {
  userExternalId: string;
  userEmail: string;
  attribute: string;          // e.g. 'department', 'job_title'
  oldValue: string | null;
  newValue: string | null;
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
  /**
   * Identity source row id. Required for directory-sourced lifecycle
   * events. MAY be null for synthetic-origin events like
   * `pluginKey: 'contractor-expiry'` where the trigger is a contract
   * end-date, not a directory sync.
   */
  sourceId: string | null;
  agencyId: string;
  pluginKey: string;
  events: LifecycleEvents;
  /**
   * For the contractor-expiry branch ONLY. Identifies the `users` row
   * whose access should be revoked. Ignored on directory-sourced paths.
   */
  userId?: string;
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
  const { sourceId, agencyId, pluginKey, events, policies, guardrails, scope, userId } = params;
  const { logger, prisma, enqueueJob } = getRuntime();

  // ─── Contractor-expiry branch ──────────────────────────────────────────
  // Dedicated path for `pluginKey: 'contractor-expiry'` auto-offboards.
  // No directory sync, no per-source scope filtering, no policy lookup —
  // contract ended, revoke every grant the contractor holds.
  if (pluginKey === 'contractor-expiry') {
    if (!userId) {
      logger.warn('[JML] contractor-expiry path requires userId', { agencyId });
      return { processed: 0, skippedByScope: 0, skippedByGuardrail: false, enqueued: 0 };
    }
    // Find all active access items for this user via access_requests.requestedBy.
    // requestedBy is the users.id (stringified) on rows created from the Users surface.
    const requests = await prisma.access_requests.findMany({
      where: { agency_id: agencyId, requestedBy: userId },
      select: { id: true },
    });
    const requestIds = requests.map((r: { id: string }) => r.id);
    const items = requestIds.length
      ? await prisma.access_request_items.findMany({
          where: {
            agency_id: agencyId,
            accessRequestId: { in: requestIds },
            status: { in: ['granted', 'validated'] },
          },
          include: { catalog_platforms: { select: { slug: true } } },
        })
      : [];

    let enqueued = 0;
    if (enqueueJob) {
      for (const it of items) {
        const platformKey = (it as { catalog_platforms?: { slug?: string | null } | null }).catalog_platforms?.slug ?? null;
        const principal = events.leavers?.[0] ?? userId;
        try {
          const id = await enqueueJob('iam_deprovision_app_user', {
            tenantId: agencyId,
            sourceId: null,
            pluginKey: platformKey ?? 'contractor-expiry',
            principal,
            accessItemId: it.id,
            triggeredBy: 'contract-expired',
            kind: 'leaver',
          });
          if (id) enqueued += 1;
        } catch (err) {
          logger.error('[JML] contractor-expiry: deprovision enqueue failed', {
            agencyId, userId, accessItemId: it.id,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // Emit a summary audit so the auto-offboard is always observable even
    // when no grants were found (empty contractor = clean no-op).
    try {
      const { publishAuditEvent } = await import('../audit/publisher.js');
      await publishAuditEvent({
        eventType: 'directory.user.contract_auto_offboarded',
        source: 'jml-lifecycle-processor',
        severity: 'warning',
        agency: { id: agencyId },
        actor: { id: 'system', type: 'system' },
        resource: { type: 'user', id: userId },
        context: { pluginKey, userId, grantsFound: items.length, grantsRevoked: enqueued },
      });
    } catch (err) {
      logger.warn('[JML] contractor-expiry: audit emit failed (non-fatal)', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    return { processed: items.length, skippedByScope: 0, skippedByGuardrail: false, enqueued };
  }

  if (!sourceId) {
    logger.warn('[JML] non-contractor pluginKey requires sourceId', { agencyId, pluginKey });
    return { processed: 0, skippedByScope: 0, skippedByGuardrail: false, enqueued: 0 };
  }

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

  // Create a `hold` row for a configured-but-deferred action so it surfaces in
  // the Scheduled-queue "Needs your decision" list (operator approve/deny).
  // Best-effort + heavily guarded: a failure here must never break lifecycle
  // processing. Resolves the principal to its directory-user UUID and dedups by
  // (user, trigger, action_type). See docs/architecture/jml-scheduled-queue.md.
  const createHoldRow = async (
    principal: string,
    kind: 'joiner' | 'leaver' | 'suspension' | 'mover',
    action: string,
  ): Promise<void> => {
    try {
      if (!principal) return;
      let userId: string | null = null;
      if (pluginKey === 'google-workspace') {
        const u = await prisma.gws_directory_users.findFirst({
          where: { source_id: sourceId, email: principal },
          select: { id: true },
        });
        userId = u?.id ?? null;
      } else {
        const u = await prisma.directory_users.findFirst({
          where: { source_id: sourceId, OR: [{ email: principal }, { external_id: principal }] },
          select: { id: true },
        });
        userId = u?.id ?? null;
      }
      if (!userId) {
        logger.warn('[JML] hold: could not resolve directory user for principal', { kind, action });
        return;
      }

      const actionType = `hold:${action}`;
      const existing = await prisma.jml_scheduled_actions.findFirst({
        where: { user_id: userId, trigger: kind, action_type: actionType, status: 'hold' },
        select: { id: true },
      });
      if (existing) return;

      await prisma.jml_scheduled_actions.create({
        data: {
          agency_id: agencyId,
          user_id: userId,
          user_email: principal,
          action_type: actionType,
          trigger: kind,
          status: 'hold',
          // Holds have no fire time — they wait for an operator decision. Stamp
          // `scheduled_at` (NOT NULL) with now() for ordering; the scheduler
          // ignores rows whose status !== 'pending'.
          scheduled_at: new Date(),
          automated: true,
          trigger_source: `directory.${pluginKey}`,
        },
      });
    } catch (err) {
      logger.error('[JML] hold row creation failed', {
        kind,
        action,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const dispatchPrimary = async (
    principal: string,
    action: string | undefined,
    primary: ResolvedAction | null,
    kind: 'joiner' | 'leaver' | 'suspension' | 'mover',
  ): Promise<void> => {
    if (!primary) {
      // Deferred (configured-but-not-enforced) → produce an operator hold.
      if (isDeferredAction(action)) await createHoldRow(principal, kind, action!);
      return;
    }
    const id = await enqueueJob(primary.jobType, {
      tenantId: agencyId,
      sourceId,
      pluginKey,
      principal,
      kind,
      triggeredBy: 'jml_process_lifecycle',
      ...(primary.extra ?? {}),
    });
    if (id) enqueued++;
  };

  // Primary per-user action jobs. Notifications are emitted below via
  // dispatchNotification so routing is driven by the agency's
  // notification_channels config rather than hardcoded email_send jobs.
  for (const email of filteredJoiners) {
    const a = policies.joiner?.action as string | undefined;
    await dispatchPrimary(email, a, resolveJoinerAction(a as never, pluginKey), 'joiner');
  }
  for (const email of filteredLeavers) {
    const a = policies.leaver?.action as string | undefined;
    await dispatchPrimary(email, a, resolveLeaverAction(a as never, pluginKey), 'leaver');
  }
  for (const email of filteredSuspended) {
    const a = policies.suspension?.action as string | undefined;
    await dispatchPrimary(email, a, resolveSuspensionAction(a as never, pluginKey, 'suspend'), 'suspension');
  }
  for (const email of filteredUnsuspended) {
    const a = policies.suspension?.action as string | undefined;
    await dispatchPrimary(email, a, resolveSuspensionAction(a as never, pluginKey, 'unsuspend'), 'suspension');
  }

  for (const change of filteredGroupChanges) {
    const principal = change.userEmail || change.userExternalId || change.userId || '';
    const addA = policies.mover?.on_group_addition?.action as string | undefined;
    const remA = policies.mover?.on_group_removal?.action as string | undefined;
    for (const _groupId of change.added ?? []) {
      await dispatchPrimary(principal, addA, resolveMoverGroupAction(addA as never, pluginKey, 'added'), 'mover');
      void _groupId;
    }
    for (const _groupId of change.removed ?? []) {
      await dispatchPrimary(principal, remA, resolveMoverGroupAction(remA as never, pluginKey, 'removed'), 'mover');
      void _groupId;
    }
  }

  const attributeChanges = events.attributeChanges ?? [];
  for (const change of attributeChanges) {
    const principal = change.userEmail || change.userExternalId;
    // Attribute changes always resolve to a job (never deferred) — pass no action.
    await dispatchPrimary(principal, undefined, resolveMoverAttributeAction(policies.mover, pluginKey), 'mover');
  }

  processed = totalFiltered + filteredGroupChanges.length + attributeChanges.length;

  // 4. Emit one aggregated notification event per non-empty kind. The
  //    dispatcher reads the agency's notification_channels and fans out to
  //    every channel that subscribes to `jml.*` or the specific event.
  //    Batching per kind (not per principal) avoids flooding channels when
  //    a large sync lands dozens of lifecycle events at once.
  await emitLifecycleEvent('jml.joiner',      filteredJoiners,      { agencyId, sourceId, pluginKey });
  await emitLifecycleEvent('jml.leaver',      filteredLeavers,      { agencyId, sourceId, pluginKey });
  await emitLifecycleEvent('jml.suspended',   filteredSuspended,    { agencyId, sourceId, pluginKey });
  await emitLifecycleEvent('jml.unsuspended', filteredUnsuspended,  { agencyId, sourceId, pluginKey });
  const moverCount = filteredGroupChanges.length + attributeChanges.length;
  if (moverCount > 0) {
    await dispatchNotification(agencyId, 'jml.mover', {
      sourceId, pluginKey, count: moverCount,
      groupChanges: filteredGroupChanges.length,
      attributeChanges: attributeChanges.length,
    });
  }

  // 5. Emit detection audit events to Elasticsearch (audit-as-source-of-truth).
  //    These are distinct from the notification events above, which go through
  //    dispatchNotification (notification channels only, never ES).
  //    The 7-day card counters in GET /api/agency/jml read these exact event
  //    types. Fire-and-forget: must not fail the lifecycle processing path.
  {
    const { publishAuditEvent } = await import('../audit/publisher.js');
    // One audit event PER detected identity so the 7-day counters in
    // GET /api/agency/jml reflect identity volume (ES doc_count), not the
    // number of sync runs. Fire-and-forget; never fails the processing path.
    const emitDetections = (eventType: string, principals: Array<string | null | undefined>): void => {
      for (const principal of principals) {
        publishAuditEvent({
          eventType,
          severity: 'info',
          source: 'jml-lifecycle-processor',
          actor: { id: null, email: null, type: 'system' },
          agency: { id: agencyId },
          context: { sourceId, pluginKey, principal: principal ?? null },
        }).catch(() => {});
      }
    };
    emitDetections('jml.joiner.detected',     filteredJoiners);
    emitDetections('jml.leaver.detected',     filteredLeavers);
    emitDetections('jml.suspension.detected', filteredSuspended);
    emitDetections('jml.mover.detected', [
      ...filteredGroupChanges.map(c => c.userEmail || c.userExternalId || c.userId),
      ...attributeChanges.map(c => c.userEmail || c.userExternalId),
    ]);
  }

  logger.info('[JML] Lifecycle events dispatched', {
    agencyId, sourceId, pluginKey,
    processed, skippedByScope, enqueued,
    joiners: filteredJoiners.length,
    leavers: filteredLeavers.length,
    suspended: filteredSuspended.length,
    unsuspended: filteredUnsuspended.length,
    groupChanges: filteredGroupChanges.length,
    attributeChanges: attributeChanges.length,
  });

  return {
    processed,
    skippedByScope,
    skippedByGuardrail: false,
    enqueued,
  };
}

// ─── Event emission helper ──────────────────────────────────────────────────

async function emitLifecycleEvent(
  eventType: string,
  principals: string[],
  ctx: { agencyId: string; sourceId: string; pluginKey: string },
): Promise<void> {
  if (principals.length === 0) return;
  await dispatchNotification(ctx.agencyId, eventType, {
    sourceId: ctx.sourceId,
    pluginKey: ctx.pluginKey,
    count: principals.length,
    principals: principals.slice(0, 50),
  });
}
