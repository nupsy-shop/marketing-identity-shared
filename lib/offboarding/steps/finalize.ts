/**
 * Step: client_offboard_finalize
 *
 * Last step in the offboarding chain. Computes the canonical evidence
 * bundle, persists its sha256 to `offboarding_runs.sha256_hash`, and
 * flips the run status to either `completed` or `completed_with_manual_tasks`
 * depending on whether any open manual tasks remain.
 *
 * Emits `client.offboarded` once the bundle is sealed. Idempotent: if
 * the run is already completed and the hash matches, the step is a no-op.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';
import { computeEvidenceBundle } from '../evidence.js';

const STEP_KEY = 'client_offboard_finalize';

export async function runFinalize(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    const { sha256 } = await computeEvidenceBundle(ctx.runId);

    const openManual = await prisma.offboarding_manual_tasks.count({
      where: { run_id: ctx.runId, status: 'open' },
    });
    const finalStatus = openManual > 0 ? 'completed_with_manual_tasks' : 'completed';

    await prisma.offboarding_runs.update({
      where: { id: ctx.runId },
      data: {
        status: finalStatus,
        sha256_hash: sha256,
        completed_at: new Date(),
      },
    });

    await publishAuditEvent({
      eventType: 'client.offboarded',
      source: 'accesshive',
      severity: 'notice',
      agencyId: ctx.agencyId,
      actor: { id: ctx.approverUserId, type: 'user' },
      resource: { type: 'client', id: ctx.clientId },
      context: {
        cause: 'client_offboarded',
        offboardingRunId: ctx.runId,
        sha256,
        status: finalStatus,
        openManualTasks: openManual,
        initiatorUserId: ctx.initiatorUserId,
        approverUserId: ctx.approverUserId,
      },
    });

    return {
      artifactIds: { sha256, status: finalStatus, openManualTasks: openManual },
    };
  });
}
