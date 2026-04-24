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
import type {
  RemediationContext,
  RemediationMode,
  RemediationPolicy,
  RemediationRecord,
  RemediationResult,
} from './remediation-types.js';

/** System template keys used when the policy does not override `autoCreateWorkflow`. */
const DEFAULT_TEMPLATE_KEY: Record<RemediationMode, string | null> = {
  manual: null,
  semi_automatic: 'semi-auto-revoke-access',
  fully_automatic: 'auto-revoke-access',
};

function publishCircuitBreakerTripped(agencyId: string): void {
  publishAuditEvent({
    type: 'remediation',
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
    const defResult = await getRuntime().prisma.workflow_definitions.findFirst({
      where: {
        key: templateKey,
        agency_id: { in: [agencyId, null as unknown as string] },
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
    await getRuntime().prisma.remediations.update({
      where: { id: remediation.id },
      data: {
        status: mode === 'fully_automatic' ? 'executing' : 'awaiting_approval',
        workflow_instance_id: workflowInstance.id,
        updated_at: new Date(),
      },
    });

    publishAuditEvent({
      type: 'remediation',
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

