/**
 * Audit-destination delivery stat helpers.
 *
 * Called by each plugin's `{key}-forward` Bull processor (and only by
 * those processors). Owns the per-destination counters, last-error
 * fields, and the consecutive-failure auto-disable rule documented in
 * docs/superpowers/specs/2026-05-26-audit-forwarding-submodule.md.
 *
 * `consecutive_failures` is reset to 0 elsewhere — when an admin
 * re-enables a destination via PATCH /api/agency/audit/destinations/[id].
 * That route lives in the web repo; this helper never resets on its own.
 */

import { getRuntime } from '../runtime.js';

const AUTO_DISABLE_THRESHOLD = 5;
const MAX_ERROR_LEN = 1000;

/**
 * Record a successful batch delivery against a destination row.
 *
 * Stat side effects:
 *   - total_forwarded     += deliveredCount
 *   - total_attempted     += deliveredCount
 *   - last_delivery_at    = now()
 *   - consecutive_failures = 0
 *   - status              = 'healthy'
 *   - last_error / last_error_at = NULL
 */
export async function recordSuccess(
  destinationId: string,
  deliveredCount: number,
): Promise<void> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit-destinations.stats] runtime.prisma not registered');

  await prisma.audit_destinations.update({
    where: { id: destinationId },
    data: {
      total_forwarded:      { increment: deliveredCount },
      total_attempted:      { increment: deliveredCount },
      last_delivery_at:     new Date(),
      consecutive_failures: 0,
      status:               'healthy',
      last_error:           null,
      last_error_at:        null,
    },
  });
}

/**
 * Record a failed batch delivery against a destination row.
 *
 * Stat side effects:
 *   - total_attempted     += attemptedCount
 *   - consecutive_failures += 1
 *   - last_error          = error.slice(0, 1000)
 *   - last_error_at       = now()
 *   - status              = 'degraded' if first failure off a healthy row,
 *                         = 'failed' (+ enabled=false) once
 *                           consecutive_failures reaches the auto-disable
 *                           threshold (5).
 *
 * The single update is split into two queries: a read of the current
 * counters, then a write of the new state. Race conditions between
 * concurrent failures on the same destination are tolerable — the worst
 * case is a one-off undercounted increment; the auto-disable threshold
 * still trips within a few additional failures.
 */
export async function recordFailure(
  destinationId: string,
  attemptedCount: number,
  error: string,
): Promise<void> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit-destinations.stats] runtime.prisma not registered');

  const current = await prisma.audit_destinations.findUnique({
    where: { id: destinationId },
    select: { consecutive_failures: true, status: true },
  });
  if (!current) return; // destination row was deleted between dispatch and processing

  const nextFailures = (current.consecutive_failures ?? 0) + 1;
  const truncated = error.length > MAX_ERROR_LEN ? error.slice(0, MAX_ERROR_LEN) : error;

  const autoDisable = nextFailures >= AUTO_DISABLE_THRESHOLD;
  const nextStatus = autoDisable
    ? 'failed'
    : (current.status === 'healthy' ? 'degraded' : current.status);

  await prisma.audit_destinations.update({
    where: { id: destinationId },
    data: {
      total_attempted:      { increment: attemptedCount },
      consecutive_failures: nextFailures,
      last_error:           truncated,
      last_error_at:        new Date(),
      status:               nextStatus,
      ...(autoDisable ? { enabled: false } : {}),
    },
  });
}
