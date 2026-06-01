/**
 * Stale checkout-approval expiry sweep (runtime-injected, tenant-scopable).
 *
 * Canonical implementation for the Bull worker's
 * `expire_checkout_approvals_for_agency` processor: batch-expires PENDING
 * `checkout_approvals` whose `requested_at` is older than
 * `maxAgeMinutes`, scoped to a single tenant.
 *
 * Mirrors the web-side `expireStaleCheckoutApprovals` semantics
 * (lib/db/checkout-approvals.ts) — PENDING → EXPIRED, stamping
 * `decided_at` and `reason='auto_expired'` — but resolves prisma from the
 * host runtime so it can run inside the worker, and filters by
 * `agency_id` for per-tenant fan-out. Idempotent.
 */

import { getRuntime } from '../runtime.js';

export interface ExpireCheckoutApprovalsOptions {
  /** Scope the sweep to a single tenant. Omit for a global sweep. */
  agencyId?: string;
  /** A PENDING approval older than this is stale. Defaults to 24h. */
  maxAgeMinutes?: number;
  /** Reference time; threshold is `now - maxAgeMinutes`. */
  now?: Date;
}

export interface ExpireCheckoutApprovalsResult {
  expiredCount: number;
  expiredIds: string[];
}

export async function expireStaleCheckoutApprovals(
  opts: ExpireCheckoutApprovalsOptions = {},
): Promise<ExpireCheckoutApprovalsResult> {
  const { agencyId, maxAgeMinutes = 1440, now = new Date() } = opts;
  const { prisma } = getRuntime();

  const threshold = new Date(now.getTime() - maxAgeMinutes * 60 * 1000);

  const staleRows: { id: string }[] = await prisma.checkout_approvals.findMany({
    where: {
      status: 'PENDING',
      requested_at: { lt: threshold },
      ...(agencyId ? { agency_id: agencyId } : {}),
    },
    select: { id: true },
  });

  if (staleRows.length === 0) {
    return { expiredCount: 0, expiredIds: [] };
  }

  const expiredIds = staleRows.map((r) => r.id);

  await prisma.checkout_approvals.updateMany({
    where: { id: { in: expiredIds } },
    data: { status: 'EXPIRED', decided_at: now, reason: 'auto_expired' },
  });

  return { expiredCount: expiredIds.length, expiredIds };
}
