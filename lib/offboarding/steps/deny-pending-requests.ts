/**
 * Step: client_offboard_deny_pending_requests
 *
 * Marks every open `access_requests` row for the offboarded client as
 * completed (denied). The schema models open vs. completed via
 * `completedAt`; once we set it the request is no longer actionable.
 *
 * Idempotent: skips rows whose `completedAt` is already set.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';

const STEP_KEY = 'client_offboard_deny_pending_requests';

export async function runDenyPendingRequests(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    const open = await prisma.access_requests.findMany({
      where: { clientId: ctx.clientId, completedAt: null },
      select: { id: true },
    });

    const closedIds: string[] = [];
    for (const r of open) {
      await prisma.access_requests.update({
        where: { id: r.id },
        data: { completedAt: new Date(), updatedAt: new Date() },
      });
      await publishAuditEvent({
        eventType: 'access_request.denied',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'access-request', id: r.id },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
        },
      });
      closedIds.push(r.id);
    }

    return { artifactIds: { accessRequests: closedIds } };
  });
}
