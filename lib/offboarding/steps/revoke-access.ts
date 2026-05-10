/**
 * Step: client_offboard_revoke_access
 *
 * Revokes every `access_items` row tied to a CLIENT_DEDICATED identity for
 * the offboarded client. Sets `revokedAt` on the row so the canonical "is
 * the user still entitled?" predicate flips immediately. External-platform
 * revocation (Keycloak disable, GWS suspend, OAuth refresh-token revoke)
 * is owned by the per-platform `disable_identities` step + plugin manifests
 * with `capabilities.revokeOnOffboard`.
 *
 * Idempotent: re-running on already-revoked rows is a no-op.
 *
 * Audit: emits `access_item.revoked` per item with `cause='client_offboarded'`
 * and the originating `offboardingRunId`.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';

const STEP_KEY = 'client_offboard_revoke_access';

export async function runRevokeAccess(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    const dedicatedIdentities = await prisma.integration_identities.findMany({
      where: { client_id: ctx.clientId, ownership: 'CLIENT_DEDICATED' },
      select: { id: true },
    });
    const identityIds = dedicatedIdentities.map((r: { id: string }) => r.id);

    if (identityIds.length === 0) {
      return { artifactIds: { accessItems: [] } };
    }

    const targets = await prisma.access_items.findMany({
      where: {
        integrationIdentityId: { in: identityIds },
        revokedAt: null,
      },
      select: { id: true, name: true },
    });

    const revokedIds: string[] = [];
    for (const item of targets) {
      await prisma.access_items.update({
        where: { id: item.id },
        data: { revokedAt: new Date() },
      });

      await publishAuditEvent({
        eventType: 'access_item.revoked',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'access-item', id: item.id, name: item.name ?? null },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
        },
      });
      revokedIds.push(item.id);
    }

    return { artifactIds: { accessItems: revokedIds } };
  });
}
