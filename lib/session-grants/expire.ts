/**
 * Session-grant expiry sweep (runtime-injected, tenant-scopable).
 *
 * Canonical implementation shared by:
 *   - the Bull worker's `expire_grants_for_agency` processor, which
 *     passes `agencyId` so each scheduled fan-out child only touches its
 *     own tenant; and
 *   - the web app's `expireGrantsJob` wrapper (global sweep).
 *
 * Flips ACTIVE grants whose `expires_at` has passed to EXPIRED and
 * appends a hash-chained EXPIRED event to each via the shared chain
 * writer (./chain.ts). Idempotent: re-running only affects grants still
 * ACTIVE. Prisma + logger come from the host via getRuntime().
 */

import { getRuntime } from '../runtime.js';
import { appendSessionEvent, type ChainTransactionClient } from './chain.js';

export interface ExpireSessionGrantsOptions {
  /** Scope the sweep to a single tenant. Omit for a global sweep. */
  agencyId?: string;
  /** Reference time; grants with `expires_at <= now` are due. */
  now?: Date;
}

export interface ExpireSessionGrantsResult {
  expiredCount: number;
  expiredIds: string[];
}

/** Structural view of the transaction client the sweep touches. */
interface SweepTransactionClient extends ChainTransactionClient {
  session_grants: {
    update(args: { where: { id: string }; data: { status: string } }): Promise<unknown>;
  };
}

export async function expireSessionGrants(
  opts: ExpireSessionGrantsOptions = {},
): Promise<ExpireSessionGrantsResult> {
  const { agencyId, now = new Date() } = opts;
  const { prisma, logger } = getRuntime();

  const grants: { id: string }[] = await prisma.session_grants.findMany({
    where: {
      status: 'ACTIVE',
      expires_at: { not: null, lte: now },
      ...(agencyId ? { agency_id: agencyId } : {}),
    },
    select: { id: true },
  });

  const expiredIds: string[] = [];

  for (const grant of grants) {
    try {
      await prisma.$transaction(async (tx: SweepTransactionClient) => {
        await tx.session_grants.update({
          where: { id: grant.id },
          data: { status: 'EXPIRED' },
        });
        await appendSessionEvent(tx, {
          sessionGrantId: grant.id,
          type: 'EXPIRED',
          metadata: { reason: 'ttl_reached' },
        });
      });
      expiredIds.push(grant.id);
    } catch (err) {
      logger.error(
        `[expireSessionGrants] failed to expire grant ${grant.id}`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  return { expiredCount: expiredIds.length, expiredIds };
}
