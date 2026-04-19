/**
 * Pure threshold helper for contractor pre-expiry notifications (issue #55).
 *
 * Returns the set of thresholds (in days) that are "due" for a given
 * contract_end_at relative to `now`. T-30 / T-14 / T-7 / T-1 is the fixed
 * cadence per the contractor-management card.
 *
 * No DB access, no side effects — unit-testable in isolation.
 */

export const CONTRACT_EXPIRY_THRESHOLDS = [30, 14, 7, 1] as const;

export type ContractExpiryThreshold = typeof CONTRACT_EXPIRY_THRESHOLDS[number];

/**
 * Given a contract_end_at and the current time, return every threshold the
 * scheduler should consider firing for this run. A threshold is "due" when
 * the days-to-expiry is `<= threshold` (i.e. we are at-or-past the trigger
 * point). Past-expiry contracts return all thresholds so the scheduler can
 * reconcile missed fires if the job was paused — dedup happens downstream
 * via `contract_notification_log`.
 */
export function contractNotificationThresholds(
  contractEndAt: Date,
  now: Date = new Date(),
): ContractExpiryThreshold[] {
  const msPerDay = 24 * 60 * 60 * 1000;
  const daysRemaining = (contractEndAt.getTime() - now.getTime()) / msPerDay;

  // Contracts that ended long ago should not keep firing "expiring" notices;
  // the expired event fires elsewhere. Bound the window to a reasonable range.
  if (daysRemaining > 30) return [];

  return CONTRACT_EXPIRY_THRESHOLDS.filter((t) => daysRemaining <= t);
}

/**
 * Convenience: the single most-specific threshold for display (smallest
 * threshold that applies). Used for the audit payload when the scheduler
 * fires one event per due threshold.
 */
export function mostSpecificThreshold(
  contractEndAt: Date,
  now: Date = new Date(),
): ContractExpiryThreshold | null {
  const all = contractNotificationThresholds(contractEndAt, now);
  if (all.length === 0) return null;
  return Math.min(...all) as ContractExpiryThreshold;
}
