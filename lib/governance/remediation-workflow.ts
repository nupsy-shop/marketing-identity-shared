/**
 * Workflow dispatch for remediations.
 *
 * Both `semi_automatic` and `fully_automatic` modes route through the
 * workflow engine — there is no direct execution path post-#93. The
 * difference between the two collapses to *which template is selected*:
 * - `semi_automatic` → `autoCreateWorkflow` or `semi-auto-revoke-access`
 *   (has an approval step before the action).
 * - `fully_automatic` → `autoCreateWorkflow` or `auto-revoke-access`
 *   (no approval step).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { incrementRateLimit, recordFailure } from './remediation-guards.js';
import { updateRemediationStatus } from './remediation-records.js';
import {
  DEFAULT_REVERT_WINDOW_HOURS,
  type RemediationContext,
  type RemediationMode,
  type RemediationPolicy,
  type RemediationRecord,
  type RemediationResult,
} from './remediation-types.js';

/** System template keys used when the policy does not override `autoCreateWorkflow`. */
const DEFAULT_TEMPLATE_KEY: Record<RemediationMode, string | null> = {
  manual: null,
  semi_automatic: 'semi-auto-revoke-access',
  fully_automatic: 'auto-revoke-access',
};

function publishCircuitBreakerTripped(agencyId: string): void {
  publishAuditEvent({
    eventType: 'remediation.rate_limited',
    action: 'rate_limited',
    actor: { id: 'system' },
    agency_id: agencyId,
    context: { reason: 'circuit_breaker_tripped' },
  }).catch(() => {});
}

/**
 * Resolve the template key for a (mode, policy) pair. Policy override wins;
 * otherwise we fall back to the documented system default for that mode. No
 * hardcoded fallbacks in consumer code — defaults live here alongside the
 * template seeder so the pair stays in sync.
 */
export function resolveTemplateKey(
  mode: RemediationMode,
  policy: RemediationPolicy,
): string | null {
  if (policy.autoCreateWorkflow) return policy.autoCreateWorkflow;
  return DEFAULT_TEMPLATE_KEY[mode];
}

/**
 * Dispatch a remediation through the workflow engine. Used for both
 * `semi_automatic` and `fully_automatic` — callers pass the mode so the
 * correct default template is picked up when no policy override exists.
 */
export async function dispatchWorkflow(
  remediation: RemediationRecord,
  policy: RemediationPolicy,
  agencyId: string,
  triggerType: string,
  context: RemediationContext,
): Promise<RemediationResult> {
  const mode = policy.mode;
  const templateKey = resolveTemplateKey(mode, policy);
  if (!templateKey) {
    await updateRemediationStatus(remediation.id, 'failed', {
      error: `No workflow template configured for mode: ${mode}`,
    });
    return {
      action: 'failed',
      remediationId: remediation.id,
      reason: 'no_workflow_configured',
    };
  }

  try {
    // Resolve the active workflow definition for this agency. System
    // templates are not stored as null-agency rows — `workflow_definitions.
    // agency_id` is NOT NULL and each template is copied into a per-agency
    // row (`is_system = true`) at install time. The previous
    // `agency_id: { in: [agencyId, null] }` form was both dead (no null rows
    // can exist) and invalid: Prisma rejects a null element inside an `in`
    // array for a scalar field, throwing on every dispatch.
    const defResult = await getRuntime().prisma.workflow_definitions.findFirst({
      where: {
        key: templateKey,
        agency_id: agencyId,
        is_active: true,
      },
      select: { id: true },
    });

    if (!defResult) {
      await updateRemediationStatus(remediation.id, 'failed', {
        error: `Workflow definition not found: ${templateKey}`,
      });
      return {
        action: 'failed',
        remediationId: remediation.id,
        reason: 'workflow_not_found',
      };
    }

    // Dynamic import avoids a circular dep with workflow engine.
    const { startWorkflow } = await import('../workflows/engine.js');
    const workflowInstance = await startWorkflow(
      defResult.id,
      {
        remediation: { id: remediation.id, triggerType },
        remediationId: remediation.id,
        ...context,
      },
      agencyId,
    );

    // Application-layer enforcement of the spec's constraint:
    // non-manual remediation rows must carry a workflow_instance_id.
    //
    // REDESIGN (#803 spec gap 2): for fully_automatic, if the workflow
    // completed synchronously within startWorkflow() (single-step templates
    // like auto-revoke-access that have no approval gate), write back
    // status=completed, executed_at, and revert_deadline = executed_at + 48h
    // immediately. If the workflow is still running/waiting, leave the row at
    // 'executing' as before — a subsequent poll / event will advance it.
    const executedAt = new Date();
    const revertDeadline = new Date(
      executedAt.getTime() + DEFAULT_REVERT_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const isFullyAutoCompleted =
      mode === 'fully_automatic' && workflowInstance.status === 'completed';

    await getRuntime().prisma.remediations.update({
      where: { id: remediation.id },
      data: {
        status: isFullyAutoCompleted
          ? 'completed'
          : mode === 'fully_automatic'
            ? 'executing'
            : 'awaiting_approval',
        workflow_instance_id: workflowInstance.id,
        ...(isFullyAutoCompleted
          ? {
              executed_at: executedAt,
              revert_deadline: revertDeadline,
            }
          : {}),
        updated_at: new Date(),
      },
    });

    publishAuditEvent({
      eventType: 'remediation.dispatched',
      action: 'dispatched',
      actor: { id: 'system' },
      agency_id: agencyId,
      target: { type: 'remediation', id: remediation.id },
      context: {
        triggerType,
        mode,
        workflowInstanceId: workflowInstance.id,
        templateKey,
      },
    }).catch(() => {});

    // Emit auto_executed audit event when the workflow completed synchronously
    // for a fully_automatic remediation (#803 spec gap 2).
    if (isFullyAutoCompleted) {
      publishAuditEvent({
        eventType: 'remediation.auto_executed',
        action: 'auto_executed',
        actor: { id: 'system' },
        agency_id: agencyId,
        target: { type: 'remediation', id: remediation.id },
        context: {
          triggerType,
          mode,
          workflowInstanceId: workflowInstance.id,
          executedAt: executedAt.toISOString(),
          revertDeadline: revertDeadline.toISOString(),
        },
      }).catch(() => {});
    }

    incrementRateLimit(agencyId);
    return {
      action: 'dispatched',
      mode,
      remediationId: remediation.id,
      workflowInstanceId: workflowInstance.id,
    };
  } catch (err) {
    getRuntime().logger.error('[Remediation] Workflow dispatch failed:', { message: (err as Error).message });
    await updateRemediationStatus(remediation.id, 'failed', {
      error: (err as Error).message,
    });
    await recordFailure(agencyId, () => publishCircuitBreakerTripped(agencyId));
    return {
      action: 'failed',
      remediationId: remediation.id,
      reason: (err as Error).message,
    };
  }
}

