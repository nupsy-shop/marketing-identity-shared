/**
 * Google OAuth refresh helper shared across Google-family plugins
 * (google-workspace, google-ads, ga4, gtm).
 *
 * Preserves the refresh semantics from the legacy
 * `lib/audit/platform-poller.ts::refreshGoogleToken` — in particular,
 * it persists the refreshed token via Prisma oauth_tokens.update and
 * returns the new access token (or null on unrecoverable failure).
 *
 * No hardcoded fallbacks — if client credentials are missing, returns
 * null rather than silently succeeding.
 */

import { getRuntime } from '../../lib/runtime.js';
import type { OAuthTokenRow, RefreshAccessTokenFn } from '../../lib/audit/platform-audit-factory.js';

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
}

/**
 * Build a refresher bound to a specific pair of env-var names, so
 * plugins like ga4 that use a dedicated OAuth client can use their
 * own credentials while still sharing the refresh logic.
 */
export function makeGoogleRefresher(clientIdEnv: string, clientSecretEnv: string): RefreshAccessTokenFn {
  return async (token: OAuthTokenRow): Promise<string | null> => {
    const { prisma, logger } = getRuntime();
    const clientId = process.env[clientIdEnv];
    const clientSecret = process.env[clientSecretEnv];

    if (!token.refreshToken || !clientId || !clientSecret) {
      logger.warn('Google token refresh: missing credentials or refresh token', {
        clientIdEnv,
        hasRefreshToken: !!token.refreshToken,
      });
      return null;
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      logger.warn(`Google token refresh failed: HTTP ${res.status}`);
      return null;
    }

    const data = (await res.json()) as GoogleTokenResponse;

    await prisma.oauth_tokens.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        expiresAt: new Date(Date.now() + (data.expires_in || 3600) * 1000),
        updatedAt: new Date(),
      },
    });

    return data.access_token;
  };
}
