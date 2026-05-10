/**
 * Drift Maintenance — issue #31.
 *
 * Per-agency worker that wires the persisted drift signal pipeline
 * (`drift_findings` rows produced by `detect_drift` + `detect_principal_drift`)
 * into the auto-remediation governance chain on a recurring schedule.
 *
 * Why this exists separately from `runEvaluationForAgency`
 * --------------------------------------------------------
 * `runEvaluationForAgency` (autoremediation_evaluate) walks every trigger in
 * `VALID_TRIGGER_TYPES` and runs the matching finder. That cycle does include
 * drift, but the cadence is owned by the broader auto-remediation cron and
 * conflates drift with stale-access / sod-violation / etc. Issue #31 needs a
 * narrowly-scoped, drift-only maintenance loop that:
 *
 *   - runs on its own cadence (independent of the broader remediation evaluator),
 *   - touches ONLY `drift_findings` (no other producers),
 *   - emits its own audit trail (`remediation.drift_maintenance.*`) so the
 *     UI can render "last drift maintenance run" separately from the
 *     general remediation evaluator,
 *   - is fully idempotent — tickling the cron more often than the producer
 *     emits findings is safe (zero-finding ticks are no-ops + an audit row).
 *
 * Governance invariants
 * ---------------------
 *   - B-gate is NEVER bypassed. We pass NO `_bypassGate` field. Tenants
 *     whose source plugin is gated (autonomy matrix `coverage='skip'`)
 *     receive a `remediation.skipped` audit event from inside
 *     `evaluateDriftDetected` and the finding stays unresolved for the next
 *     tick.
 *   - Prisma only — uses the existing `driftFinder` finder, which queries
 *     `drift_findings` via `getRuntime().prisma`. No raw SQL.
 *   - Agency-scoped — every Prisma call inside the chain filters on
 *     `agencyId`. The bull-worker side wraps this in `withTenantContext`.
 *   - Audit emission — every per-agency tick publishes a start + finish
 *     event via `publishAuditEvent` regardless of finding count.
 *   - Idempotent — re-running for the same agency on the same minute does
 *     NOT double-execute already-executed remediations: rate-limit and
 *     circuit-breaker guards inside `evaluateAndRemediate` short-circuit
 *     repeats, and `dispatchDriftWorkflow` upserts on
 *     (agency_id, source_plugin_key, principal_type, principal_id).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { driftFinder } from './remediation-finders/drift.js';
import { loadPolicies } from './remediation-policies.js';
import { evaluateAndRemediate } from './remediation-engine.js';
import type { RemediationPolicy, RemediationResult } from './remediation-types.js';

export interface DriftMaintenanceResult {
  agencyId: string;
  status: 'completed' | 'skipped_no_policy' | 'failed';
  findingsScanned: number;
  actionsTaken: number;
  skipped: number;
  error?: string;
}

const ACTION_OUTCOMES = new Set<RemediationResult['action']>([
  'auto_executed',
  'workflow_created',
  'scheduled',
  'dry_run',
]);

/**
 * Run one drift-maintenance tick for one agency. Safe to call repeatedly.
 *
 * Selection rules:
 *   - Pulls open `drift_findings` (state='unhealthy', resolved_at IS NULL)
 *     via `driftFinder`, honouring the agency's drift exclusion policy
 *     (excludePlatforms / excludeUsers).
 *   - If the agency has no `drift` policy at all, returns
 *     `skipped_no_policy` without touching findings — the operator hasn't
 *     opted in yet, and a missing policy is treated as manual.
 *
 * Caller (bull worker) wraps in `withTenantContext(agencyId, …)`.
 */
export async function runDriftMaintenanceForAgency(
  agencyId: string,
): Promise<DriftMaintenanceResult> {
  const { logger } = getRuntime();

  await publishAuditEvent({
    type: 'remediation',
    action: 'drift_maintenance_started',
    actor: { id: 'system' },
    agency_id: agencyId,
    context: { trigger: 'drift_maintenance_cron' },
  }).catch(() => {});

  const policies = await loadPolicies(agencyId);
  const policy = policies.drift as RemediationPolicy | undefined;

  if (!policy) {
    await publishAuditEvent({
      type: 'remediation',
      action: 'drift_maintenance_skipped',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: { reason: 'no_drift_policy' },
    }).catch(() => {});
    return {
      agencyId,
      status: 'skipped_no_policy',
      findingsScanned: 0,
      actionsTaken: 0,
      skipped: 0,
    };
  }

  let findingsScanned = 0;
  let actionsTaken = 0;
  let skipped = 0;

  try {
    const findings = await driftFinder(agencyId, policy);
    findingsScanned = findings.length;

    for (const finding of findings) {
      // Pass through the finding context as-is. Critically, we DO NOT set
      // `_bypassGate` — the autonomy matrix must be enforced. Gated
      // tenants receive a `remediation.skipped` audit event from inside
      // `evaluateDriftDetected` and the finding stays unresolved.
      const result = await evaluateAndRemediate(
        agencyId,
        'drift.detected',
        finding.context,
      );

      if (ACTION_OUTCOMES.has(result.action)) {
        actionsTaken++;
      } else {
        skipped++;
      }
    }

    await publishAuditEvent({
      type: 'remediation',
      action: 'drift_maintenance_completed',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: {
        findingsScanned,
        actionsTaken,
        skipped,
      },
    }).catch(() => {});

    return {
      agencyId,
      status: 'completed',
      findingsScanned,
      actionsTaken,
      skipped,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('[DriftMaintenance] tick failed', { agencyId, message });
    await publishAuditEvent({
      type: 'remediation',
      action: 'drift_maintenance_failed',
      actor: { id: 'system' },
      agency_id: agencyId,
      context: {
        findingsScanned,
        actionsTaken,
        skipped,
        error: message,
      },
    }).catch(() => {});
    return {
      agencyId,
      status: 'failed',
      findingsScanned,
      actionsTaken,
      skipped,
      error: message,
    };
  }
}
