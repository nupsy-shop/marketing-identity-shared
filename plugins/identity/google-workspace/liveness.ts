/**
 * Google Workspace — liveness probe.
 *
 * Performs a real refresh-token round-trip via the host-registered
 * `resolveGwsAccessToken` callback (see `lib/runtime.ts`), then a
 * minimal Admin Directory read to confirm the token still authorizes
 * the API. Returns a {@link LivenessResult} categorized so the
 * platform-health checker can flip the source to the right state:
 *
 *   - `ok: true`               → connected (or stays degraded if sync stale)
 *   - `errorCategory: 'auth'`  → needs_reauth (refresh-token revoked / expired)
 *   - `errorCategory: 'server'`/`'network'`/`'unknown'` → error (transient)
 *
 * Falls back to a public OIDC discovery heartbeat ONLY when the host
 * hasn't registered `resolveGwsAccessToken` (rare — historically used
 * by the bull worker before the token helper was moved to shared, see
 * #988). The fallback never reports `auth`, so it cannot transition a
 * source out of `degraded` — it exists strictly to keep the probe
 * non-throwing in that legacy bootstrap case.
 *
 * Invariants:
 *   - Read-only: never mutates `connection_config` or rotates tokens.
 *   - Bounded: 10s timeout per outbound call.
 *   - Token never persisted or logged.
 */

import type { LivenessResult } from '../../../lib/platform-health/types.js';
import { getRuntime } from '../../../lib/runtime.js';
import { resolveLivenessOverride } from '../../../lib/platform-health/liveness-override.js';

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

export async function checkGoogleWorkspace(
  source: SourceForLiveness,
): Promise<LivenessResult> {
  // E2E provider-override seam: consult BEFORE any credential check or real
  // outbound call so test tenants can drive forced 5xx/401 deterministically.
  // No-op for real agencies (gated by agencies.is_test_tenant).
  const override = await resolveLivenessOverride(
    source.agencyId,
    'gws',
    'https://admin.googleapis.com/admin/directory/v1/users',
  );
  if (override) return override;

  const cfg = source.connectionConfig || {};
  const customerId = cfg.customerId as string | undefined;
  const primaryDomain = cfg.primaryDomain as string | undefined;

  if (!customerId || !primaryDomain) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'missing GWS customer_id or primary domain',
    };
  }

  const { resolveGwsAccessToken } = getRuntime();
  if (!resolveGwsAccessToken) {
    // Host did not register a resolver — fall back so the probe still
    // runs. Documented in the file header; not a real liveness signal.
    return checkGoogleWorkspaceHeartbeat();
  }

  let accessToken: string | null = null;
  try {
    accessToken = await resolveGwsAccessToken(source.agencyId);
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'unknown',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (!accessToken) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'refresh_token_invalid',
    };
  }

  const start = Date.now();
  try {
    const url =
      `https://admin.googleapis.com/admin/directory/v1/users` +
      `?customer=${encodeURIComponent(customerId)}` +
      `&maxResults=1&fields=kind`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
      // Drain the body so the response is GC'd; result is unused.
      await res.json().catch(() => ({}));
      return { ok: true, latencyMs };
    }

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        latencyMs,
        errorCategory: 'auth',
        errorMessage: `HTTP ${res.status}`,
      };
    }
    return {
      ok: false,
      latencyMs,
      errorCategory: res.status >= 500 ? 'server' : 'unknown',
      errorMessage: `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      errorCategory: 'network',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Public OIDC discovery heartbeat. Strictly a fallback — never reports
 * `auth`, so cannot drive a `connected → needs_reauth` transition.
 * Retained for hosts that haven't registered `resolveGwsAccessToken`.
 */
async function checkGoogleWorkspaceHeartbeat(): Promise<LivenessResult> {
  const start = Date.now();
  try {
    const res = await fetch(
      'https://accounts.google.com/.well-known/openid-configuration',
      {
        method: 'GET',
        signal: AbortSignal.timeout(10_000),
      },
    );
    const latencyMs = Date.now() - start;
    if (res.ok) return { ok: true, latencyMs };
    return {
      ok: false,
      latencyMs,
      errorCategory: res.status >= 500 ? 'server' : 'unknown',
      errorMessage: `HTTP ${res.status}`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      errorCategory: 'network',
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
