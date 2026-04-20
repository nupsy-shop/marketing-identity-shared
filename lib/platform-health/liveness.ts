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
