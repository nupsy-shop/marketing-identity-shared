/**
 * Step: client_offboard_pause_scim_and_remediation
 *
 * Pauses upstream provisioning + automated remediation against the
 * offboarded client:
 *   - Revokes every active `scim_connections` row scoped to the client
 *     so upstream IdP pushes stop arriving.
 *   - Cancels any `remediations` rows that target a CLIENT_DEDICATED
 *     identity for this client AND are still pending/scheduled — so
 *     queued auto-fixes don't run after offboarding lands.
 *
 * Idempotent: skips already-revoked SCIM rows and already-finalised
 * remediations.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';

const STEP_KEY = 'client_offboard_pause_scim_and_remediation';

export async function runPauseScimAndRemediation(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    // 1. Revoke active SCIM connections for the client.
    const scim = await prisma.scim_connections.findMany({
      where: { client_id: ctx.clientId, status: { not: 'revoked' } },
      select: { id: true, idp_type: true },
    });
    const scimIds: string[] = [];
    for (const c of scim) {
      await prisma.scim_connections.update({
        where: { id: c.id },
        data: {
          status: 'revoked',
          revoked_at: new Date(),
          revoked_by: ctx.approverUserId,
        },
      });
      await publishAuditEvent({
        eventType: 'scim.connection_revoked',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'scim-connection', id: c.id },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
          idpType: c.idp_type,
        },
      });
      scimIds.push(c.id);
    }

    // 2. Cancel pending remediations targeting client identities. We
    //    look up the client's identities and match by target_user_id.
    const ids = await prisma.integration_identities.findMany({
      where: { client_id: ctx.clientId, ownership: 'CLIENT_DEDICATED' },
      select: { id: true },
    });
    const identityIds = ids.map((i: { id: string }) => i.id);

    let remediationIds: string[] = [];
    if (identityIds.length > 0) {
      const pending = await prisma.remediations.findMany({
        where: {
          target_user_id: { in: identityIds },
          status: { in: ['pending', 'scheduled'] },
        },
        select: { id: true },
      });
      for (const r of pending) {
        await prisma.remediations.update({
          where: { id: r.id },
          data: { status: 'cancelled' },
        });
        await publishAuditEvent({
          eventType: 'remediation.cancelled',
          source: 'accesshive',
          severity: 'info',
          agencyId: ctx.agencyId,
          actor: { id: ctx.approverUserId, type: 'user' },
          resource: { type: 'remediation', id: r.id },
          context: {
            cause: 'client_offboarded',
            offboardingRunId: ctx.runId,
            clientId: ctx.clientId,
          },
        });
      }
      remediationIds = pending.map((p: { id: string }) => p.id);
    }

    return {
      artifactIds: { scimConnections: scimIds, remediations: remediationIds },
    };
  });
}
