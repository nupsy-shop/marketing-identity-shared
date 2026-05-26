/**
 * Platform Health — provider-response override bridge for liveness probes.
 *
 * Each plugin liveness probe (GWS, Entra) makes a real outbound HTTP call to
 * a third-party IdP. Per the host's provider-override contract
 * (lib/http/provider-override-resolver.ts), outbound callers must consult
 * `resolveProviderOverride` BEFORE dialling the real endpoint so E2E tests can
 * drive the failure branches (forced 5xx → error, forced 401 → needs_reauth)
 * deterministically — without real credentials or network round-trips, and
 * only for agencies carrying `is_test_tenant=true`.
 *
 * This helper centralises the override→{@link LivenessResult} mapping so both
 * probes stay consistent. Returns `undefined` when no override applies (real
 * production path) or when the host registered no resolver.
 */

import { getRuntime } from '../runtime.js';
import type { LivenessResult } from './types.js';

/**
 * Consult the host's provider-override resolver for this outbound URL and map
 * any forced response onto a LivenessResult.
 *
 *   - status < 400          → ok (the probe would have succeeded)
 *   - status 401 / 403      → auth   → checker flips to needs_reauth
 *   - status >= 500         → server → checker flips to error
 *   - other 4xx             → unknown → checker flips to error
 *
 * @returns the mapped LivenessResult, or `undefined` to fall through to the
 *          real liveness call.
 */
export async function resolveLivenessOverride(
  agencyId: string,
  provider: string,
  url: string,
): Promise<LivenessResult | undefined> {
  const { resolveProviderOverride } = getRuntime();
  if (!resolveProviderOverride) return undefined;

  let override: { status: number; body: unknown; delayMs?: number } | null;
  try {
    override = await resolveProviderOverride(agencyId, provider, url);
  } catch {
    // Fail-closed: never let the override seam break a real liveness check.
    return undefined;
  }
  if (!override) return undefined;

  const latencyMs = override.delayMs ?? 0;
  const { status } = override;

  if (status < 400) {
    return { ok: true, latencyMs };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      latencyMs,
      errorCategory: 'auth',
      errorMessage: `HTTP ${status} (forced override)`,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      latencyMs,
      errorCategory: 'server',
      errorMessage: `HTTP ${status} (forced override)`,
    };
  }
  return {
    ok: false,
    latencyMs,
    errorCategory: 'unknown',
    errorMessage: `HTTP ${status} (forced override)`,
  };
}
