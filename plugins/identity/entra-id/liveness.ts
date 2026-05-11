/**
 * Microsoft Entra ID — liveness probe.
 *
 * Performs a `client_credentials` token exchange against the Microsoft
 * login endpoint. Validates tenant + client credentials without touching
 * Graph. Returns a {@link LivenessResult} categorized so the
 * platform-health checker can flip the source to the right state:
 *
 *   - `ok: true`               → connected (or stays degraded if sync stale)
 *   - `errorCategory: 'auth'`  → needs_reauth (401/403 from token endpoint
 *                                  → tenant disabled, client secret rotated/expired,
 *                                  permissions revoked)
 *   - `errorCategory: 'server'`/`'network'`/`'unknown'` → error (transient)
 *
 * Tenancy:
 *   - Reads `tenantId` / `clientId` / `clientSecret` from the source's
 *     `connection_config`, falling back to env vars (`ENTRA_ID_CLIENT_ID`
 *     / `ENTRA_ID_CLIENT_SECRET` and the legacy `MICROSOFT_*` aliases).
 *     Bull worker registers the same env vars as web, so no host
 *     resolver callback is needed (unlike GWS).
 *
 * Invariants:
 *   - Read-only: never mutates `connection_config`, never persists the
 *     returned access token (read into memory and discarded).
 *   - Bounded: 10s timeout.
 *   - Secrets never logged.
 */

import type { LivenessResult } from '../../../lib/platform-health/types.js';

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

export async function checkEntra(
  source: SourceForLiveness,
): Promise<LivenessResult> {
  const cfg = source.connectionConfig || {};
  const tenantId = cfg.tenantId as string | undefined;
  const clientId =
    (cfg.clientId as string | undefined) ||
    process.env.ENTRA_ID_CLIENT_ID ||
    process.env.MICROSOFT_CLIENT_ID;
  const clientSecret =
    (cfg.clientSecret as string | undefined) ||
    process.env.ENTRA_ID_CLIENT_SECRET ||
    process.env.MICROSOFT_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'missing Entra credentials',
    };
  }

  const start = Date.now();
  try {
    const res = await fetch(
      `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const latencyMs = Date.now() - start;

    if (res.ok) {
      // Drain the body so the token is GC'd. Never persisted.
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
