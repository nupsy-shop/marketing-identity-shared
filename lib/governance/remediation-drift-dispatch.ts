/**
 * Dispatch a surviving `drift.detected` signal into the workflow engine
 * (issue #90). Autonomy matrix, policy exclusions, rate limit + circuit
 * breaker have ALL been evaluated by `evaluateDriftDetected` before we
 * arrive here — this module is pure dispatch.
 *
 * Template selection runs through `rule-matcher.matchWorkflow` with
 * `triggerType = 'drift.detected'` + full context. The default mapping
 * (seeded by `templates.ts`) is
 * `local-directory + identity + keycloak_missing → drift-link-keycloak-identity`.
 *
 * The workflow engine is imported dynamically to avoid a circular dep
 * between governance and workflows (same pattern as
 * `remediation-workflow.ts`).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { incrementRateLimit, recordFailure } from './remediation-guards.js';
import { createRemediationRecord } from './remediation-records.js';
import type { RemediationContext, RemediationResult } from './remediation-types.js';

function publishCircuitBreakerTripped(agencyId: string): void {
  publishAuditEvent({
    eventType: 'remediation.rate_limited',
    action: 'rate_limited',
    actor: { id: 'system' },
    agency_id: agencyId,
    context: { reason: 'circuit_breaker_tripped' },
  }).catch(() => {});
}

export async function dispatchDriftWorkflow(
  agencyId: string,
  context: RemediationContext,
): Promise<RemediationResult> {
  const remediation = await createRemediationRecord(
    agencyId,
    'drift',
    context,
    'fully_automatic',
  );

  try {
    const { matchWorkflow } = await import('../workflows/rule-matcher.js');
    const definition = await matchWorkflow(
      agencyId,
      'drift.detected',
      context as Record<string, unknown>,
    );

    if (!definition) {
      await recordFailure(agencyId, () => publishCircuitBreakerTripped(agencyId));
      publishAuditEvent({
        eventType: 'remediation.failed',
        action: 'failed',
        actor: { id: 'system' },
        agency_id: agencyId,
        target: { type: 'remediation', id: remediation.id },
        context: { triggerType: 'drift.detected', reason: 'no_template_matched', ...context },
      }).catch(() => {});
      return {
        action: 'failed',
        remediationId: remediation.id,
        reason: 'no_template_matched',
      };
    }

    const { startWorkflow } = await import('../workflows/engine.js');
    const instance = await startWorkflow(
      definition.id,
      { remediationId: remediation.id, triggerType: 'drift.detected', ...context },
      agencyId,
    );

    publishAuditEvent({
      eventType: 'remediation.dispatched',
      action: 'dispatched',
      actor: { id: 'system' },
      agency_id: agencyId,
      target: { type: 'remediation', id: remediation.id },
      context: {
        triggerType: 'drift.detected',
        workflowInstanceId: instance.id,
        workflowKey: definition.key,
        ...context,
      },
    }).catch(() => {});

    incrementRateLimit(agencyId);
    return {
      action: 'workflow_created',
      remediationId: remediation.id,
      workflowInstanceId: instance.id,
    };
  } catch (err) {
    getRuntime().logger.error(
      '[Remediation] drift.detected dispatch failed:',
      { message: (err as Error).message },
    );
    await recordFailure(agencyId, () => publishCircuitBreakerTripped(agencyId));
    publishAuditEvent({
      eventType: 'remediation.failed',
      action: 'failed',
      actor: { id: 'system' },
      agency_id: agencyId,
      target: { type: 'remediation', id: remediation.id },
      context: { triggerType: 'drift.detected', error: (err as Error).message },
    }).catch(() => {});
    return {
      action: 'failed',
      remediationId: remediation.id,
      reason: (err as Error).message,
    };
  }
}
