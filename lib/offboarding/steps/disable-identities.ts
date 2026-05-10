/**
 * Step: client_offboard_disable_identities
 *
 * Marks every CLIENT_DEDICATED identity tied to this client as inactive
 * and flips `provisioning_status` to `REVOKED`. Per-platform external
 * disable (Keycloak, GWS suspend, Entra disable) is fanned out from this
 * row via the existing `iam_disable_app_user` provisioning queue when the
 * platform manifest declares `capabilities.revokeOnOffboard`. Manifests
 * without that capability remain manual — the execute endpoint already
 * created `offboarding_manual_tasks` rows for them up front.
 *
 * Idempotent: skips identities that are already inactive + revoked.
 */

import { runStep, type StepContext } from './_runner.js';
import { getRuntime } from '../../runtime.js';
import { publishAuditEvent } from '../../audit/publisher.js';

const STEP_KEY = 'client_offboard_disable_identities';

export async function runDisableIdentities(ctx: StepContext) {
  return runStep(STEP_KEY, ctx, async () => {
    const { prisma } = getRuntime();

    const targets = await prisma.integration_identities.findMany({
      where: {
        client_id: ctx.clientId,
        ownership: 'CLIENT_DEDICATED',
        OR: [{ isActive: true }, { provisioning_status: { not: 'REVOKED' } }],
      },
      select: { id: true, name: true, platform_key: true },
    });

    const disabledIds: string[] = [];
    for (const id of targets) {
      await prisma.integration_identities.update({
        where: { id: id.id },
        data: {
          isActive: false,
          provisioning_status: 'REVOKED',
          updatedAt: new Date(),
        },
      });

      await publishAuditEvent({
        eventType: 'identity.revoked',
        source: 'accesshive',
        severity: 'info',
        agencyId: ctx.agencyId,
        actor: { id: ctx.approverUserId, type: 'user' },
        resource: { type: 'identity', id: id.id, name: id.name ?? null },
        context: {
          cause: 'client_offboarded',
          offboardingRunId: ctx.runId,
          clientId: ctx.clientId,
          platformKey: id.platform_key ?? null,
        },
      });
      disabledIds.push(id.id);
    }

    return { artifactIds: { identities: disabledIds } };
  });
}
