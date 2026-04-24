/**
 * Evaluation-run persistence + per-agency evaluation cycle.
 *
 * Extracted from `remediation-engine.ts` as part of issue #91. Every
 * scheduled/on-demand run writes a first-class `remediation_evaluations` row
 * so the UI can render "Last evaluated …" and zero-action runs in the
 * Recent Activity timeline (closes Known gap #10).
 */

import { getRuntime } from '../runtime.js';
import { Prisma } from '@prisma/client';
import { loadPolicies } from './remediation-policies.js';
import { FINDERS } from './remediation-finders/index.js';
import type {
  EvaluationRunRow,
  EvaluationSource,
  EvaluationStartResult,
  RemediationPolicy,
  RemediationResult,
  TriggerType,
} from './remediation-types.js';
import { VALID_TRIGGER_TYPES } from './remediation-types.js';

/**
 * E2E-only mid-execution crash hook. Used by the
 * `run-remediation-evaluator-with-crash.ts` test harness to inject a
 * controlled failure mid-evaluation so we can assert the engine persists a
 * `remediation_evaluations` row with `status='failed'` on unexpected throws
 * (Category D @target scenario). Hard-gated on NODE_ENV !== 'production' —
 * in prod this is always `undefined`, regardless of what the env var says.
 *
 *   E2E_REMEDIATION_MID_HOOK       = 'throw' | 'exit' | undefined
 *   E2E_REMEDIATION_MID_HOOK_AFTER = int (findings processed before firing)
 */
function midExecutionHook(): 'throw' | 'exit' | undefined {
  if (process.env.NODE_ENV === 'production') return undefined;
  const v = process.env.E2E_REMEDIATION_MID_HOOK;
  if (v === 'throw' || v === 'exit') return v;
  return undefined;
}

export async function startEvaluationRun(
  agencyId: string,
  source: EvaluationSource,
): Promise<EvaluationStartResult> {
  const row = await getRuntime().prisma.remediation_evaluations.create({
    data: { agency_id: agencyId, source, status: 'running' },
    select: { id: true, started_at: true },
  });
  return { id: row.id, startedAt: row.started_at };
}

export async function finishEvaluationRun(
  id: string,
  opts: {
    agencyId: string;
    triggerCounts: Record<string, { scanned: number; evaluated: number; actions: number }>;
    status: 'completed' | 'failed';
    error?: string | null;
  },
): Promise<void> {
  const finishedAt = new Date();
  await getRuntime().prisma.remediation_evaluations.update({
    where: { id },
    data: {
      finished_at: finishedAt,
      trigger_counts: opts.triggerCounts as Prisma.InputJsonValue,
      status: opts.status,
      error: opts.error || null,
    },
  });
  if (opts.status === 'completed') {
    // Only mirror the timestamp on success — a failed run must not pretend
    // to be the latest successful eval (scenarios.feature, gap #10).
    await getRuntime().prisma.agency_settings
      .update({
        where: { agency_id: opts.agencyId },
        data: { last_remediation_eval_at: finishedAt },
      })
      .catch(() => {});
  }
}

export async function listEvaluationRuns(
  agencyId: string,
  limit = 20,
): Promise<EvaluationRunRow[]> {
  interface EvalRow {
    id: string;
    agency_id: string;
    started_at: Date;
    finished_at: Date | null;
    trigger_counts: Record<string, unknown> | null;
    status: string;
    error: string | null;
    source: string;
  }
  const rows = (await getRuntime().prisma.remediation_evaluations.findMany({
    where: { agency_id: agencyId },
    orderBy: { started_at: 'desc' },
    take: limit,
  })) as EvalRow[];
  return rows.map((r): EvaluationRunRow => ({
    id: r.id,
    agencyId: r.agency_id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    triggerCounts: (r.trigger_counts as Record<string, unknown>) || {},
    status: r.status,
    error: r.error,
    source: r.source,
  }));
}

/**
 * Run one full evaluation cycle for an agency. Used by both the Bull cron
 * job (`autoremediation_evaluate`) and the on-demand `POST /evaluate` API.
 *
 * Injects the engine's `evaluateAndRemediate` + `executeScheduledRemediations`
 * via parameters to avoid a circular import between engine and this module.
 */
export async function runEvaluationForAgency(
  agencyId: string,
  source: EvaluationSource,
  deps: {
    evaluateAndRemediate: (
      agencyId: string,
      triggerType: string,
      context: Record<string, unknown>,
    ) => Promise<RemediationResult>;
    executeScheduledRemediations: () => Promise<RemediationResult[]>;
  },
): Promise<{
  evaluationId: string;
  triggerCounts: Record<string, { scanned: number; evaluated: number; actions: number }>;
  status: 'completed' | 'failed';
  error?: string;
}> {
  const run = await startEvaluationRun(agencyId, source);
  const triggerCounts: Record<string, { scanned: number; evaluated: number; actions: number }> = {};

  try {
    // Execute any scheduled remediations first — grace-period expirations
    // need a heartbeat every cycle. Count them under a synthetic "_scheduled"
    // trigger so the UI can show "3 deferred actions executed".
    const scheduledResults = await deps.executeScheduledRemediations();
    triggerCounts._scheduled = {
      scanned: scheduledResults.length,
      evaluated: scheduledResults.length,
      actions: scheduledResults.filter((r) => r.action === 'auto_executed').length,
    };

    const policies = await loadPolicies(agencyId);

    for (const triggerType of VALID_TRIGGER_TYPES) {
      const policy = policies[triggerType] as RemediationPolicy | undefined;
      if (!policy || policy.mode === 'manual') {
        triggerCounts[triggerType] = { scanned: 0, evaluated: 0, actions: 0 };
        continue;
      }
      const producer = FINDERS[triggerType as TriggerType];
      const findings = producer ? await producer(agencyId, policy) : [];
      let actions = 0;
      let findingsProcessed = 0;
      const hook = midExecutionHook();
      const hookAfter = Number(process.env.E2E_REMEDIATION_MID_HOOK_AFTER ?? 1);
      for (const finding of findings) {
        if (hook && findingsProcessed >= hookAfter) {
          if (hook === 'exit') process.exit(7);
          throw new Error('E2E_MID_EXECUTION_CRASH');
        }
        const r = await deps.evaluateAndRemediate(
          agencyId,
          triggerType,
          finding.context,
        );
        findingsProcessed++;
        if (
          r.action === 'auto_executed' ||
          r.action === 'workflow_created' ||
          r.action === 'scheduled' ||
          r.action === 'dry_run'
        ) {
          actions++;
        }
      }
      triggerCounts[triggerType] = {
        scanned: findings.length,
        evaluated: findings.length,
        actions,
      };
    }

    await finishEvaluationRun(run.id, { agencyId, triggerCounts, status: 'completed' });

    return { evaluationId: run.id, triggerCounts, status: 'completed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    getRuntime().logger.error('[Remediation] Evaluation run failed:', { message });
    await finishEvaluationRun(run.id, {
      agencyId,
      triggerCounts,
      status: 'failed',
      error: message,
    }).catch(() => {});
    return { evaluationId: run.id, triggerCounts, status: 'failed', error: message };
  }
}
