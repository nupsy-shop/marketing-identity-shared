/**
 * Step: client_offboard_unassign_team
 *
 * Deactivates every active `client_role_assignments` row and
 * `client_owner_assignments` row for the offboarded client. The user
 * accounts themselves are untouched (they may still belong to other
 * clients in the agency); only the client-scoped role bindings are torn
 * down.
 *
 * Idempotent: re-running on already-deactivated rows is a no-op.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';

const STEP_KEY = 'client_offboard_unassign_team';

export async function runUnassignTeam(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    const roles = await prisma.client_role_assignments.findMany({
      where: { client_id: ctx.clientId, is_active: true },
      select: { id: true, app_user_id: true, role: true },
    });
    const owners = await prisma.client_owner_assignments.findMany({
      where: { client_id: ctx.clientId, is_active: true },
      select: { id: true, owner_type: true, app_user_id: true, directory_group_id: true },
    });

    const roleIds: string[] = [];
    for (const r of roles) {
      await prisma.client_role_assignments.update({
        where: { id: r.id },
        data: { is_active: false, updated_at: new Date() },
      });
      await publishAuditEvent({
        eventType: 'client.role_unassigned',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'client-role-assignment', id: r.id },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
          appUserId: r.app_user_id,
          role: r.role,
        },
      });
      roleIds.push(r.id);
    }

    const ownerIds: string[] = [];
    for (const o of owners) {
      await prisma.client_owner_assignments.update({
        where: { id: o.id },
        data: { is_active: false, updated_at: new Date() },
      });
      await publishAuditEvent({
        eventType: 'client.owner_unassigned',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'client-owner-assignment', id: o.id },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
          ownerType: o.owner_type,
          appUserId: o.app_user_id ?? null,
          directoryGroupId: o.directory_group_id ?? null,
        },
      });
      ownerIds.push(o.id);
    }

    return {
      artifactIds: { roleAssignments: roleIds, ownerAssignments: ownerIds },
    };
  });
}
