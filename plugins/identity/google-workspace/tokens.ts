/**
 * Google Workspace — OAuth token management (shared host).
 *
 * Returns a valid access token for the given agency's GWS identity source,
 * refreshing through the Google OAuth endpoint when the cached access
 * token is expired (or about to expire). Persists the refreshed token
 * back to `oauth_tokens` so subsequent callers reuse it.
 *
 * Why this lives in shared:
 *   - The web app's request handlers and the Bull worker both need to
 *     obtain a live access token. The platform-health liveness probe
 *     (shared/lib/platform-health/liveness.ts) is the bull-side caller —
 *     without a shared helper, the bull worker fell back to a public
 *     OIDC heartbeat that never reports `auth` errors, leaving sources
 *     stuck in stale `degraded` state even when the refresh token was
 *     dead at Google. (#988.)
 *
 * Tenancy:
 *   - Web previously got agency scoping from `getDb()` (RLS via
 *     AsyncLocalStorage tenant context). The shared helper has no access
 *     to that and takes `agencyId` as an explicit parameter — every
 *     query filters on it directly. The thin web shim
 *     (`lib/integrations/google-workspace-tokens.ts`) resolves
 *     `agencyId` from the existing tenant context and forwards.
 *
 * Invariants:
 *   - Read-only with respect to the OAuth client config (env vars).
 *   - Mutates `oauth_tokens` only on a successful refresh; never on
 *     read failures.
 *   - Returns `null` on any failure path so callers can treat "no token"
 *     uniformly. The platform-health checker maps null → `auth` error
 *     → `needs_reauth` state.
 */

import { getRuntime } from '../../../lib/runtime.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PLUGIN_KEY = 'google-workspace';

/** Refresh if the cached access token expires within this window. */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export interface ValidAccessToken {
  accessToken: string;
  scopes: string[];
  metadata: Record<string, unknown>;
}

interface OAuthTokenRow {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scopes: string[];
  metadata: Record<string, unknown> | null;
}

/**
 * Get a valid access token for the agency's Google Workspace source,
 * refreshing through Google's OAuth endpoint when needed.
 *
 * Returns null when:
 *   - No active `oauth_tokens` row exists for this agency + plugin.
 *   - The cached token is expired AND no refresh token is stored.
 *   - The refresh attempt failed (revoked grant, network, etc.).
 *
 * Does NOT fall back to an expired token — Google rejects them with
 * misleading 403s that mask the real "user must reconnect" signal.
 */
export async function getValidAccessToken(
  agencyId: string,
): Promise<ValidAccessToken | null> {
  const { prisma, logger } = getRuntime();

  const token = (await prisma.oauth_tokens.findFirst({
    where: {
      platformKey: PLUGIN_KEY,
      scope: 'AGENCY',
      isActive: true,
      agency_id: agencyId,
    },
    orderBy: { createdAt: 'desc' },
  })) as OAuthTokenRow | null;

  if (!token) return null;

  const expiresAtMs = token.expiresAt ? token.expiresAt.getTime() : 0;
  const isExpired = Date.now() > expiresAtMs - TOKEN_EXPIRY_BUFFER_MS;

  if (isExpired && token.refreshToken) {
    const refreshed = await refreshAccessToken(token);
    if (refreshed) {
      return {
        accessToken: refreshed.accessToken,
        scopes: refreshed.scopes ?? token.scopes ?? [],
        metadata: (refreshed.metadata ?? token.metadata ?? {}) as Record<
          string,
          unknown
        >,
      };
    }
    logger.error(
      '[gws-tokens] Refresh failed — agency must reconnect GWS',
      { agencyId },
    );
    return null;
  }

  if (isExpired && !token.refreshToken) {
    logger.error(
      '[gws-tokens] Token expired and no refresh token stored — agency must reconnect GWS',
      { agencyId },
    );
    return null;
  }

  return {
    accessToken: token.accessToken,
    scopes: token.scopes ?? [],
    metadata: (token.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * POST refresh_token to Google's token endpoint, persist the result, and
 * return the updated token row. Null on any failure (logged once).
 *
 * Google sometimes returns a new refresh_token on refresh and sometimes
 * does not — we only update refresh_token when the response includes one.
 */
async function refreshAccessToken(
  token: OAuthTokenRow,
): Promise<OAuthTokenRow | null> {
  const { prisma, logger } = getRuntime();

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    logger.error(
      '[gws-tokens] OAuth client credentials missing from env (GOOGLE_OAUTH_CLIENT_ID/SECRET)',
    );
    return null;
  }

  let response: Response;
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken ?? '',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch (err: unknown) {
    logger.error('[gws-tokens] Refresh network error', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    logger.error('[gws-tokens] Refresh rejected by Google', {
      status: response.status,
      error: errorText,
    });
    return null;
  }

  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
  } | null;

  if (!data?.access_token) {
    logger.error('[gws-tokens] Refresh response missing access_token');
    return null;
  }

  const expiresAt = data.expires_in
    ? new Date(Date.now() + data.expires_in * 1000)
    : null;

  const updateData: Record<string, unknown> = {
    accessToken: data.access_token,
    expiresAt,
    scopes: data.scope ? data.scope.split(' ') : token.scopes,
    updatedAt: new Date(),
  };
  if (data.refresh_token) {
    updateData.refreshToken = data.refresh_token;
  }

  const updated = (await prisma.oauth_tokens.update({
    where: { id: token.id },
    data: updateData,
  })) as OAuthTokenRow;

  return updated;
}

/**
 * Validate that the granted OAuth scopes cover the required set for a
 * given operating mode. Pure function — no host services needed.
 *
 * READ_ONLY mode covers user/group/orgunit/domain reads.
 * PROVISIONING mode adds writes (the readonly subset is implied because
 * the write scope subsumes its readonly counterpart at Google's side).
 */
export function validateScopesForMode(
  grantedScopes: string[],
  mode: string,
): { valid: boolean; missing: string[] } {
  const requiredReadOnly = [
    'https://www.googleapis.com/auth/admin.directory.user.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
    'https://www.googleapis.com/auth/admin.directory.orgunit.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  ];

  const requiredProvisioning = [
    'https://www.googleapis.com/auth/admin.directory.user',
    'https://www.googleapis.com/auth/admin.directory.orgunit',
    'https://www.googleapis.com/auth/admin.directory.group.readonly',
    'https://www.googleapis.com/auth/admin.directory.group.member.readonly',
    'https://www.googleapis.com/auth/admin.directory.domain.readonly',
  ];

  const required = mode === 'PROVISIONING' ? requiredProvisioning : requiredReadOnly;

  const granted = new Set(grantedScopes ?? []);

  // The write scope (e.g. .../admin.directory.user) subsumes the readonly
  // (e.g. .../admin.directory.user.readonly) — accept either.
  const missing = required.filter((scope) => {
    if (granted.has(scope)) return false;
    const writeScope = scope.replace('.readonly', '');
    if (writeScope !== scope && granted.has(writeScope)) return false;
    return true;
  });

  return { valid: missing.length === 0, missing };
}
