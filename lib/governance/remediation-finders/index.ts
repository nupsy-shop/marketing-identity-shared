/**
 * Finder registry. Each trigger type maps to exactly one finder function.
 *
 * The scheduler walks every agency with policies configured and invokes
 * every producer whose trigger type has a non-manual policy. Producers
 * return the *findings* — each finding becomes one call to
 * `evaluateAndRemediate`. All finders use Prisma; no `$queryRaw`.
 */

import type { Finder, TriggerType } from '../remediation-types.js';
import { staleAccessFinder } from './stale-access.js';
import { expiredAccessFinder } from './expired-access.js';
import { failedVerificationFinder } from './failed-verification.js';
import { driftFinder } from './drift.js';
import { sodViolationFinder } from './sod-violation.js';
import { overProvisionedFinder } from './over-provisioned.js';

export const FINDERS: Record<TriggerType, Finder> = {
  staleAccess: staleAccessFinder,
  expiredAccess: expiredAccessFinder,
  failedVerification: failedVerificationFinder,
  drift: driftFinder,
  sodViolation: sodViolationFinder,
  overProvisioned: overProvisionedFinder,
};

/**
 * Trigger types that have a real producer today. The others are stubs
 * returning `[]`; the UI shows a "Detector not yet wired" badge for them.
 * Preserved from the original engine's `PRODUCERS_WITH_DETECTORS` set.
 */
export const PRODUCERS_WITH_DETECTORS: Readonly<Set<string>> = new Set([
  'staleAccess',
  'expiredAccess',
  'failedVerification',
  'drift',
]);

export {
  staleAccessFinder,
  expiredAccessFinder,
  failedVerificationFinder,
  driftFinder,
  sodViolationFinder,
  overProvisionedFinder,
};
