/**
 * Auto-Remediation Engine — thin orchestrator. See sibling modules for the
 * decomposed responsibilities (issue #91): remediation-types, -policies,
 * -guards, -finders/, -records, -executor, -workflow, -revert, -evaluations.
 *
 * Modes: manual (recommend), semi_automatic (approval workflow), and
 * fully_automatic (execute + revert window).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { resolveEntitlementsFromDb } from '../entitlements/resolve.js';
import { loadPolicies } from './remediation-policies.js';
import {
  applyGracePeriod,
  checkCircuitBreaker,
  checkRateLimit,
  incrementRateLimit,
  isDryRun,
  isExcluded,
  persistSuppressedFinding,
} from './remediation-guards.js';
import {
  createRemediationRecord,
  updateRemediationStatus,
} from './remediation-records.js';
import { executeScheduledRemediations } from './remediation-executor.js';
import { dispatchWorkflow } from './remediation-workflow.js';
import { dispatchDriftWorkflow } from './remediation-drift-dispatch.js';
import { evaluateAutonomy } from './remediation-autonomy.js';
import { runEvaluationForAgency as runEvaluationForAgencyImpl } from './remediation-evaluations.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_MAX_ACTIONS_PER_HOUR,
  VALID_TRIGGER_TYPES,
  type Entitlements,
  type EvaluationSource,
  type RemediationContext,
  type RemediationPolicies,
  type RemediationPolicy,
  type RemediationResult,
  type TriggerType,
} from './remediation-types.js';

// Re-exports: preserve the module's public surface for existing callers.
export { listRemediations, getRemediationById } from './remediation-records.js';
export {
  executeScheduledRemediations,
  cancelRemediation,
} from './remediation-executor.js';
export {
  startEvaluationRun,
  finishEvaluationRun,
  listEvaluationRuns,
} from './remediation-evaluations.js';
export { PRODUCERS_WITH_DETECTORS, FINDERS as PRODUCERS } from './remediation-finders/index.js';
export type {
  EvaluationSource,
  EvaluationStartResult,
  EvaluationRunRow,
  ProducerFinding,
} from './remediation-types.js';

/**
 * Evaluate a trigger and execute the configured remediation policy.
 */
export async function evaluateAndRemediate(
  agencyId: string,
  triggerType: string,
  context: RemediationContext = {},
): Promise<RemediationResult> {
  // `drift.detected` is the event emitted by the principal drift detector
  // (issue #90). Autonomy matrix enforcement lives here — filtered signals
  // never reach policy/rate-limit/circuit checks, so they can't consume
  // capacity meant for real workflows. Surviving signals are dispatched
  // into the workflow engine via rule-matcher → template selection.
  if (triggerType === 'drift.detected') {
    return evaluateDriftDetected(agencyId, context);
  }

  if (!VALID_TRIGGER_TYPES.includes(triggerType as TriggerType)) {
    getRuntime().logger.warn('[Remediation] Unknown trigger type', { triggerType });
    return { action: 'invalid_trigger' };
  }

  const policies: RemediationPolicies = await loadPolicies(agencyId);
  const policy = policies[triggerType] as RemediationPolicy | undefined;

  publishAuditEvent({
    type: 'remediation',
    action: 'evaluated',
    actor: { id: 'system' },
    agency_id: agencyId,
    context: { triggerType, mode: policy?.mode || 'manual', ...context },
  }).catch(() => {});

  if (!policy || policy.mode === 'manual') {
    publishAuditEvent({
      type: 'remediation',
      action: 'manual_recommended',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: { triggerType, ...context },
    }).catch(() => {});
    return { action: 'manual_recommended', mode: 'manual' };
  }

  // Feature gate — downgrade or reject modes the agency's tier can't serve.
  const gate = await enforceFeatureGate(agencyId, policy);
  if (gate) return gate;

  if (isExcluded(policy, context)) return { action: 'excluded' };

  const maxPerHour =
    (policies.maxActionsPerHour as number | undefined) || DEFAULT_MAX_ACTIONS_PER_HOUR;
  if (await checkRateLimit(agencyId, maxPerHour)) {
    const row = await createRemediationRecord(agencyId, triggerType, context, policy.mode);
    await persistSuppressedFinding({
      remediationId: row.id,
      agencyId,
      triggerType,
      resultPayload: {
        error: 'rate_limit_exceeded',
        code: 'rate_limit_exceeded',
        maxPerHour,
      },
      auditContext: { maxPerHour },
    });
    return { action: 'rate_limited', remediationId: row.id, reason: 'rate_limit_exceeded' };
  }

  if (await checkCircuitBreaker(agencyId)) {
    const row = await createRemediationRecord(agencyId, triggerType, context, policy.mode);
    await persistSuppressedFinding({
      remediationId: row.id,
      agencyId,
      triggerType,
      resultPayload: {
        error: 'circuit_breaker_open',
        code: 'circuit_breaker',
        threshold: CIRCUIT_BREAKER_THRESHOLD,
      },
      auditContext: { reason: 'circuit_breaker' },
    });
    return {
      action: 'circuit_breaker_open',
      remediationId: row.id,
      reason: 'circuit_breaker',
    };
  }

  const remediation = await createRemediationRecord(
    agencyId,
    triggerType,
    context,
    policy.mode,
  );

  if (isDryRun(policy)) {
    await updateRemediationStatus(remediation.id, 'dry_run');
    publishAuditEvent({
      type: 'remediation',
      action: 'dry_run',
      actor: { id: 'system' },
      agency_id: agencyId,
      target: { type: 'remediation', id: remediation.id },
      context: { triggerType, wouldExecute: policy.mode, ...context },
    }).catch(() => {});
    return { action: 'dry_run', remediationId: remediation.id };
  }

  // Grace period applies only to fully_automatic — semi_automatic already
  // has an operator approval gate so additional delay is redundant.
  if (policy.mode === 'fully_automatic') {
    const scheduledAt = applyGracePeriod(policy);
    if (scheduledAt) {
      await getRuntime().prisma.remediations.update({
        where: { id: remediation.id },
        data: { status: 'scheduled', scheduled_at: scheduledAt, updated_at: new Date() },
      });
      publishAuditEvent({
        type: 'remediation',
        action: 'scheduled',
        actor: { id: 'system' },
        agency_id: agencyId,
        target: { type: 'remediation', id: remediation.id },
        context: {
          triggerType,
          scheduledAt: scheduledAt.toISOString(),
          gracePeriodHours: policy.gracePeriodHours,
        },
      }).catch(() => {});
      incrementRateLimit(agencyId);
      return { action: 'scheduled', remediationId: remediation.id };
    }
  }

  if (policy.mode === 'semi_automatic' || policy.mode === 'fully_automatic') {
    return dispatchWorkflow(remediation, policy, agencyId, triggerType, context);
  }

  return { action: 'unknown_mode', mode: policy.mode };
}

/**
 * Enforce the agency's entitlement tier. Returns a short-circuit result
 * when the requested mode isn't available; otherwise mutates `policy.mode`
 * in place (semi_automatic fallback) and returns `null` to continue.
 */
async function enforceFeatureGate(
  agencyId: string,
  policy: RemediationPolicy,
): Promise<RemediationResult | null> {
  const entitlements = (await resolveEntitlementsFromDb(agencyId)) as Entitlements;
  const hasAutoRemediation = entitlements.features?.autoRemediation ?? false;
  const hasAutoRemediationFull = entitlements.features?.autoRemediationFull ?? false;

  if (policy.mode === 'semi_automatic' && !hasAutoRemediation) {
    return { action: 'manual_recommended', mode: 'manual', reason: 'tier_insufficient' };
  }
  if (policy.mode === 'fully_automatic' && !hasAutoRemediationFull) {
    if (hasAutoRemediation) {
      policy.mode = 'semi_automatic';
      return null;
    }
    return { action: 'manual_recommended', mode: 'manual', reason: 'tier_insufficient' };
  }
  return null;
}

/**
 * `drift.detected` orchestration path (issue #90).
 *
 * Order of operations — matches the spec's safety invariants:
 *   1. Autonomy matrix (`jml_owns_users` / `deferred_to_pr_e` → skip audit)
 *   2. Policy exclusions + dryRun short-circuit
 *   3. Rate limiter + circuit breaker (applied BEFORE workflow start)
 *   4. Template selection (rule-matcher) + workflow start
 *
 * All DB access is Prisma; agency_id scoping is enforced by the caller's
 * context and the underlying helpers (guards, record, workflow).
 */
async function evaluateDriftDetected(
  agencyId: string,
  context: RemediationContext,
): Promise<RemediationResult> {
  const sourcePluginKey = (context.sourcePluginKey as string) || '';
  const principalType = (context.principalType as string) || '';

  const decision = evaluateAutonomy(sourcePluginKey, principalType);

  if (decision.coverage === 'skip') {
    publishAuditEvent({
      type: 'remediation',
      action: 'skipped',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: {
        triggerType: 'drift.detected',
        reason: decision.reason,
        sourcePluginKey,
        principalType,
        ...context,
      },
    }).catch(() => {});
    return { action: 'skipped', reason: decision.reason };
  }

  // Reuse the existing `drift` policy shape. Missing policy = manual default.
  const policies: RemediationPolicies = await loadPolicies(agencyId);
  const policy = (policies.drift as RemediationPolicy | undefined) ?? { mode: 'fully_automatic' };

  if (isExcluded(policy, context)) return { action: 'excluded' };
  if (policy.mode === 'manual') {
    return { action: 'manual_recommended', mode: 'manual' };
  }

  const maxPerHour =
    (policies.maxActionsPerHour as number | undefined) || DEFAULT_MAX_ACTIONS_PER_HOUR;
  if (await checkRateLimit(agencyId, maxPerHour)) {
    return { action: 'rate_limited', reason: 'rate_limit_exceeded' };
  }
  if (await checkCircuitBreaker(agencyId)) {
    return { action: 'circuit_breaker_open', reason: 'circuit_breaker' };
  }

  if (isDryRun(policy)) {
    publishAuditEvent({
      type: 'remediation',
      action: 'dry_run',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: { triggerType: 'drift.detected', ...context },
    }).catch(() => {});
    return { action: 'dry_run' };
  }

  return dispatchDriftWorkflow(agencyId, context);
}

/**
 * Run one full evaluation cycle for an agency. Thin wrapper that injects the
 * engine's entry-points into the evaluations module so we avoid a circular
 * import between engine and evaluations.
 */
export function runEvaluationForAgency(
  agencyId: string,
  source: EvaluationSource,
): ReturnType<typeof runEvaluationForAgencyImpl> {
  return runEvaluationForAgencyImpl(agencyId, source, {
    evaluateAndRemediate: (a, t, c) =>
      evaluateAndRemediate(a, t, c as RemediationContext),
    executeScheduledRemediations,
  });
}
