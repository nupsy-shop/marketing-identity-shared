/**
 * Platform Health — per-provider liveness checks.
 *
 * Dispatches by plugin key. Each provider contributes a lightweight
 * liveness function that returns `{ok, latencyMs, errorCategory?}`
 * without rotating tokens or mutating credentials (invariant).
 *
 * Providers currently wired:
 *   - entra-id         : client_credentials token exchange against the
 *                         Microsoft login endpoint. Validates tenant +
 *                         client secret without touching Graph.
 *   - google-workspace : public OIDC discovery heartbeat. Not a proxy
 *                         for admin API availability, but detects
 *                         wholesale provider outage without minting a
 *                         service-account JWT.
 *
 * For any plugin not wired, returns `undefined` — the orchestrator then
 * falls back to the sync-signal-only evaluation in `evaluateHealth`.
 */

import type { LivenessResult } from './types.js';
import { getRuntime } from '../runtime.js';

/**
 * E2E provider-response override hook.
 *
 * Sibling of the web-app's `lib/http/provider-override-resolver.ts` — the
 * resolver lives there; here we read the same `provider_response_overrides`
 * table inline via the runtime-injected Prisma client so the shared
 * submodule stays portable (both web and worker ship this code).
 *
 * Fail-closed: every error path returns null and the real fetch continues.
 * Non-prod gated: only active when NODE_ENV !== 'production' OR
 * E2E_ENABLED === 'true'. Agency-scoped: every read carries `agency_id`.
 * When a matching row exists, we synthesize a LivenessResult from the forced
 * status so platform-health @target scenarios (e.g. "GWS admin API returns
 * 500") can drive deterministic outcomes without touching the real provider.
 */
type ProviderName = 'gws' | 'entra' | 'slack' | 'lago' | 'sendgrid' | 'keycloak';

function overridesEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.E2E_ENABLED === 'true';
}

async function livenessOverrideFor(
  agencyId: string,
  provider: ProviderName,
  url: string,
): Promise<LivenessResult | null> {
  if (!overridesEnabled()) return null;
  if (!agencyId || !provider || !url) return null;

  let status: number;
  let delayMs = 0;
  try {
    const { prisma } = getRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (prisma as any).provider_response_overrides.findMany({
      where: { agency_id: agencyId, provider },
      select: {
        endpoint_match: true,
        status: true,
        delay_ms: true,
        created_at: true,
      },
    })) as Array<{
      endpoint_match: string;
      status: number;
      delay_ms: number;
      created_at: Date;
    }>;
    if (rows.length === 0) return null;

    // Longest substring wins (most specific). Ties → oldest row wins.
    const matches = rows
      .filter((r) => r.endpoint_match.length > 0 && url.includes(r.endpoint_match))
      .sort((a, b) => {
        if (b.endpoint_match.length !== a.endpoint_match.length) {
          return b.endpoint_match.length - a.endpoint_match.length;
        }
        return a.created_at.getTime() - b.created_at.getTime();
      });
    if (matches.length === 0) return null;
    status = matches[0]!.status;
    delayMs = matches[0]!.delay_ms ?? 0;
  } catch {
    // Fail-closed. Table may not exist yet, or prisma may be unavailable in a
    // stripped-down runtime. Never throw — the real fetch continues.
    return null;
  }

  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (status >= 200 && status < 300) {
    return { ok: true, latencyMs: delayMs };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      latencyMs: delayMs,
      errorCategory: 'auth',
      errorMessage: `HTTP ${status} (forced override)`,
    };
  }
  return {
    ok: false,
    latencyMs: delayMs,
    errorCategory: status >= 500 ? 'server' : 'unknown',
    errorMessage: `HTTP ${status} (forced override)`,
  };
}

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

export async function runLivenessCheck(
  source: SourceForLiveness,
): Promise<LivenessResult | undefined> {
  if (source.connectionState === 'disconnected') return undefined;

  switch (source.pluginKey) {
    case 'entra-id':
      return checkEntra(source);
    case 'google-workspace':
      return checkGoogleWorkspace(source);
    default:
      return undefined;
  }
}

async function checkEntra(source: SourceForLiveness): Promise<LivenessResult> {
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

  // E2E override hook: see tests/support/scripts/seed/set-provider-response.ts.
  // Checked BEFORE credential validation so platform-health @target scenarios
  // can simulate the Microsoft token endpoint returning 5xx / 401 / 429
  // without needing a real Entra tenant. Fail-closed; production path
  // untouched. The substring match on `login.microsoftonline.com` is stable
  // regardless of tenant id.
  const entraProbeUrl = tenantId
    ? `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`
    : `https://login.microsoftonline.com/oauth2/v2.0/token`;
  const earlyEntraOverride = await livenessOverrideFor(
    source.agencyId,
    'entra',
    entraProbeUrl,
  );
  if (earlyEntraOverride) return earlyEntraOverride;

  if (!tenantId || !clientId || !clientSecret) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'missing Entra credentials',
    };
  }

  const tokenUrl = entraProbeUrl;

  const start = Date.now();
  try {
    const res = await fetch(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
        }),
        // 10s timeout — liveness must not block the scheduler.
        signal: AbortSignal.timeout(10_000),
      },
    );
    const latencyMs = Date.now() - start;

    if (res.ok) {
      // Read the body so the token is garbage-collected with the response.
      // We deliberately do NOT persist or cache it — liveness is read-only.
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

async function checkGoogleWorkspace(source: SourceForLiveness): Promise<LivenessResult> {
  const cfg = source.connectionConfig || {};
  const customerId = cfg.customerId as string | undefined;
  const primaryDomain = cfg.primaryDomain as string | undefined;

  // E2E override hook: see tests/support/scripts/seed/set-provider-response.ts.
  // Checked BEFORE credential resolution so platform-health @target scenarios
  // can simulate GWS admin-API 5xx/403/429 without needing real OAuth tokens
  // on the isolation agency. Fail-closed; production path untouched.
  const gwsProbeUrl =
    `https://admin.googleapis.com/admin/directory/v1/users` +
    (customerId ? `?customer=${encodeURIComponent(customerId)}` : '') +
    `&maxResults=1&fields=kind`;
  const earlyGwsOverride = await livenessOverrideFor(source.agencyId, 'gws', gwsProbeUrl);
  if (earlyGwsOverride) return earlyGwsOverride;

  if (!customerId || !primaryDomain) {
    return {
      ok: false,
      latencyMs: 0,
      errorCategory: 'auth',
      errorMessage: 'missing GWS customer_id or primary domain',
    };
  }

  // Resolve an access token through the host-registered callback.
  // Shared code cannot import the web app's token helper directly;
  // the resolver runs inside the agency's tenant context.
  const { resolveGwsAccessToken } = getRuntime();
  if (!resolveGwsAccessToken) {
    // Host did not register a resolver (e.g. worker context). Fall back to
    // the public-endpoint heartbeat so the check still runs — this matches
    // pre-fix behavior and never flips 'auth'.
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

  const url = gwsProbeUrl;

  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    const latencyMs = Date.now() - start;

    if (res.ok) {
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

// Preserved as a fallback for hosts that haven't registered
// resolveGwsAccessToken (notably the worker). Not a real liveness signal,
// but strictly better than throwing.
async function checkGoogleWorkspaceHeartbeat(): Promise<LivenessResult> {
  const start = Date.now();
  try {
    const res = await fetch('https://accounts.google.com/.well-known/openid-configuration', {
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
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
