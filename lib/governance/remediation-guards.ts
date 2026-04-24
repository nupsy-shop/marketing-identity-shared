/**
 * Safety guards for the remediation engine.
 *
 * Extracted from `remediation-engine.ts` as part of issue #91. Pure
 * behaviour-preserving move; the circuit-breaker query, exclusion predicate,
 * grace-period scheduling helper, dry-run predicate and secret scrubber all
 * moved here verbatim.
 */

import { getRuntime } from '../runtime.js';
import { Prisma } from '@prisma/client';
import { publishAuditEvent } from '../audit/publisher.js';
import {
  isRateLimited as redisIsRateLimited,
  incrementActionCount,
} from './remediation-rate-limiter.js';
import {
  CIRCUIT_BREAKER_THRESHOLD,
  DEFAULT_MAX_ACTIONS_PER_HOUR,
  type RemediationContext,
  type RemediationPolicy,
  type RemediationResult,
} from './remediation-types.js';

// --- Rate limiting -----------------------------------------------------------
// Redis-backed limiter lives in `./remediation-rate-limiter`. These are thin
// wrappers so existing call sites don't need to await the async increment
// inline when they're already inside an `await`ed flow.

/**
 * Check whether the agency has exceeded its hourly remediation budget.
 * Thin wrapper around `remediation-rate-limiter` so the engine can import a
 * single guards surface.
 */
export async function checkRateLimit(
  agencyId: string,
  maxPerHour: number = DEFAULT_MAX_ACTIONS_PER_HOUR,
): Promise<boolean> {
  return redisIsRateLimited(agencyId, maxPerHour);
}

export function incrementRateLimit(agencyId: string): void {
  incrementActionCount(agencyId).catch((err) =>
    getRuntime().logger.warn(
      '[Remediation] rate-limit increment failed:',
      err instanceof Error ? err.message : String(err),
    ),
  );
}

// --- Circuit breaker ---------------------------------------------------------

/**
 * Whether the circuit breaker is currently open — i.e., the agency has hit
 * `CIRCUIT_BREAKER_THRESHOLD` failed remediations in the trailing hour.
 */
export async function checkCircuitBreaker(agencyId: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const count = await getRuntime().prisma.remediations.count({
    where: {
      agency_id: agencyId,
      status: 'failed',
      created_at: { gt: oneHourAgo },
    },
  });
  return count >= CIRCUIT_BREAKER_THRESHOLD;
}

/** Legacy name retained for the engine's existing call sites. */
export const isCircuitBreakerOpen = checkCircuitBreaker;

/**
 * On a freshly-failed remediation, check whether the breaker has just tripped
 * and invoke the caller's `publishAudit` hook if so. Kept as a
 * no-side-effect-besides-audit helper so the engine can fire-and-forget.
 */
export async function recordFailure(
  agencyId: string,
  publishAudit: (reason: string) => void,
): Promise<void> {
  const open = await checkCircuitBreaker(agencyId);
  if (open) publishAudit('circuit_breaker_tripped');
}

export async function resetFailureCount(_agencyId: string): Promise<void> {
  // No-op: failures are time-windowed, no need to explicitly reset. Kept as
  // a named symbol so the engine's "on success, reset" call reads clearly.
}

/**
 * Persist a suppressed-by-guard remediation row and emit the matching audit
 * event. Shared between the rate-limit and circuit-breaker branches of the
 * orchestrator so the engine doesn't duplicate ~20 lines of persistence for
 * each. Behaviour (row shape, status, result payload, audit event) is
 * identical to the inline blocks it replaces.
 */
export async function persistSuppressedFinding(args: {
  remediationId: string;
  agencyId: string;
  triggerType: string;
  resultPayload: Record<string, unknown>;
  auditContext: Record<string, unknown>;
}): Promise<void> {
  await getRuntime().prisma.remediations.update({
    where: { id: args.remediationId },
    data: {
      status: 'failed',
      result: args.resultPayload as Prisma.InputJsonValue,
      updated_at: new Date(),
    },
  });
  publishAuditEvent({
    type: 'remediation',
    action: 'rate_limited',
    actor: { id: 'system' },
    agency_id: args.agencyId,
    target: { type: 'remediation', id: args.remediationId },
    context: { triggerType: args.triggerType, ...args.auditContext },
  }).catch(() => {});
}

/** Re-export for engine convenience — keeps suppress-result construction typed. */
export type SuppressedResult = RemediationResult;

// --- Exclusions --------------------------------------------------------------

/**
 * Apply platform/user exclusion lists from policy. Returns `true` when the
 * finding should be skipped entirely (no row persisted).
 */
export function isExcluded(
  policy: RemediationPolicy,
  context: RemediationContext,
): boolean {
  if (policy.excludePlatforms?.length && context.platformKey) {
    if (policy.excludePlatforms.includes(context.platformKey)) return true;
  }
  if (policy.excludeUsers?.length) {
    const userId = context.userId || context.targetUserId;
    if (userId && policy.excludeUsers.includes(userId)) return true;
  }
  return false;
}

/** Spec-named alias for `isExcluded`. */
export const applyExclusions = isExcluded;

// --- Grace period & dry-run predicates --------------------------------------

/** Whether the policy requests a dry-run (no side effects). */
export function isDryRun(policy: RemediationPolicy): boolean {
  return !!policy.dryRun;
}

/**
 * Compute the `scheduled_at` timestamp for a policy with a grace period, or
 * `null` if the policy requests immediate execution.
 */
export function applyGracePeriod(policy: RemediationPolicy): Date | null {
  const gracePeriodHours = policy.gracePeriodHours || 0;
  if (gracePeriodHours <= 0) return null;
  return new Date(Date.now() + gracePeriodHours * 60 * 60 * 1000);
}

// --- Secret scrubbing --------------------------------------------------------
// Keys likely to carry credentials. Stripped from `context` and
// `before_state` before anything is persisted to `remediations`.

const SECRET_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /apikey/i,
  /api_key/i,
  /credential/i,
  /oauth/i,
  /access_key/i,
  /private_key/i,
];

export function scrubSecrets<T extends Record<string, unknown> | null | undefined>(
  input: T,
): T {
  if (!input || typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERNS.some((p) => p.test(k))) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}
