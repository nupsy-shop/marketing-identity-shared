/**
 * Step runner — idempotent wrapper that owns the `offboarding_run_steps`
 * row lifecycle.
 *
 * All six client-offboarding handlers (revoke_access, disable_identities,
 * unassign_team, pause_scim_and_remediation, deny_pending_requests,
 * finalize) follow the same shape:
 *
 *   1. Find-or-create the per-step row (composite key: run_id + step_key).
 *   2. If the step is already `completed`, return — re-run is a no-op.
 *      This is the BullMQ idempotency contract; jobs may retry after
 *      the database write has already landed.
 *   3. Mark `running`, invoke the inner work, and on success persist the
 *      collected `artifact_ids`. On failure persist `error` and re-throw
 *      so Bull surfaces the failure for retry.
 *
 * `step_key` is the BullMQ job-type string (e.g. `client_offboard_revoke_access`).
 */

import type { Prisma } from '@prisma/client';
import { getRuntime } from '../../runtime.js';

export interface StepContext {
  runId: string;
  agencyId: string;
  clientId: string;
  triggeredBy: string;
  /** SoD: who initiated the run (audit-only; not enforced here). */
  initiatorUserId: string;
  /** SoD: who approved the run; this is the actor for the destructive writes. */
  approverUserId: string;
}

export interface StepWork {
  artifactIds: unknown;
}

type StepFn = (ctx: StepContext) => Promise<StepWork>;

export async function runStep(
  stepKey: string,
  ctx: StepContext,
  work: StepFn,
): Promise<{ skipped: boolean; artifactIds: unknown }> {
  const { prisma, logger } = getRuntime();

  // Idempotency: if any prior run of this step completed, return early.
  const existing = await prisma.offboarding_run_steps.findFirst({
    where: { run_id: ctx.runId, step_key: stepKey },
  });
  if (existing && existing.status === 'completed') {
    logger.info('[offboarding] step already completed, skipping', {
      runId: ctx.runId,
      stepKey,
    });
    return { skipped: true, artifactIds: existing.artifact_ids ?? null };
  }

  const stepRow = existing
    ? await prisma.offboarding_run_steps.update({
        where: { id: existing.id },
        data: { status: 'running', started_at: new Date(), error: null },
      })
    : await prisma.offboarding_run_steps.create({
        data: {
          run_id: ctx.runId,
          step_key: stepKey,
          status: 'running',
          started_at: new Date(),
        },
      });

  try {
    const result = await work(ctx);
    await prisma.offboarding_run_steps.update({
      where: { id: stepRow.id },
      data: {
        status: 'completed',
        completed_at: new Date(),
        artifact_ids: (result.artifactIds ?? null) as Prisma.InputJsonValue,
      },
    });
    return { skipped: false, artifactIds: result.artifactIds ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.offboarding_run_steps.update({
      where: { id: stepRow.id },
      data: {
        status: 'failed',
        error: { message } as Prisma.InputJsonValue,
      },
    });
    throw err;
  }
}
