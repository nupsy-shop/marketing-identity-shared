/**
 * Entra ID — Shared OAuth token resolver
 *
 * Extracted from entra-sync-directory.ts (lines 607-756). Used by both
 * entra_sync_directory and entra_create_user processors to resolve a valid
 * Microsoft Graph access token from either a stored OAuth token (delegated
 * flow) or client credentials (app-only flow).
 *
 * No behaviour change — pure extraction.
 */

const MSFT_TOKEN_URL = 'https://login.microsoftonline.com';

/**
 * Resolve a valid Microsoft Graph access token for the given identity source.
 *
 * Resolution order:
 * 1. Stored OAuth token (delegated flow) — refresh if expired.
 * 2. Client credentials flow using env vars / connection_config.
 *
 * Returns null if no token can be obtained (caller should throw so Bull
 * retries, or log + skip depending on context).
 */
export async function resolveEntraAccessToken(
  prisma: any,
  source: { oauth_token_id: string | null; connection_config: unknown },
  logger: any,
): Promise<string | null> {
  const config = (source.connection_config || {}) as Record<string, unknown>;

  // Prefer OAuth token if stored (delegated flow)
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({
      where: { id: source.oauth_token_id },
    });

    if (token && token.isActive !== false) {
      const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
      const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;

      if (!isExpired) return token.accessToken;

      // Attempt token refresh if refresh token available
      if (token.refreshToken) {
        const refreshed = await refreshOAuthToken(prisma, token, logger);
        if (refreshed) return refreshed;
      }

      logger.warn('resolveEntraAccessToken: OAuth token expired and could not be refreshed', {
        tokenId: token.id,
      });
      // Fall through to client credentials
    }
  }

  // Client credentials flow
  const msftTenantId = config.tenantId as string | undefined;
  const clientId =
    (config.clientId as string) ||
    process.env.ENTRA_ID_CLIENT_ID ||
    process.env.MICROSOFT_CLIENT_ID;
  const clientSecret =
    (config.clientSecret as string) ||
    process.env.ENTRA_ID_CLIENT_SECRET ||
    process.env.MICROSOFT_CLIENT_SECRET;

  if (!msftTenantId || !clientId || !clientSecret) {
    logger.error(
      'resolveEntraAccessToken: missing client credentials (tenantId, clientId, clientSecret)',
    );
    return null;
  }

  try {
    const res = await fetch(`${MSFT_TOKEN_URL}/${encodeURIComponent(msftTenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    });

    if (!res.ok) {
      let errorText = '';
      try { errorText = await res.text(); } catch { /* ignore */ }
      logger.error('resolveEntraAccessToken: client credentials token request failed', {
        status: res.status,
        error: errorText.slice(0, 300),
      });
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    return data.access_token;
  } catch (err) {
    logger.error('resolveEntraAccessToken: token request error', {
      error: (err as Error).message,
    });
    return null;
  }
}

async function refreshOAuthToken(
  prisma: any,
  token: any,
  logger: any,
): Promise<string | null> {
  // Entra OAuth refresh requires tenantId from the token or env
  const tenantId =
    (token.metadata as any)?.tenantId ||
    process.env.ENTRA_ID_TENANT_ID ||
    process.env.MICROSOFT_TENANT_ID;
  const clientId =
    (token.metadata as any)?.clientId ||
    process.env.ENTRA_ID_CLIENT_ID ||
    process.env.MICROSOFT_CLIENT_ID;
  const clientSecret =
    process.env.ENTRA_ID_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET;

  if (!tenantId || !clientId || !clientSecret) return null;

  try {
    const res = await fetch(`${MSFT_TOKEN_URL}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
        scope: 'https://graph.microsoft.com/.default',
      }),
    });

    if (!res.ok) {
      let errorText = '';
      try { errorText = await res.text(); } catch { /* ignore */ }
      logger.error('resolveEntraAccessToken: OAuth token refresh failed', {
        tokenId: token.id,
        status: res.status,
        error: errorText.slice(0, 300),
      });
      return null;
    }

    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    const newExpiresAt = data.expires_in
      ? new Date(Date.now() + data.expires_in * 1000)
      : null;

    await prisma.oauth_tokens.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        expiresAt: newExpiresAt,
        ...(data.refresh_token ? { refreshToken: data.refresh_token } : {}),
        updatedAt: new Date(),
      },
    });

    return data.access_token;
  } catch (err) {
    logger.error('resolveEntraAccessToken: OAuth refresh error', {
      error: (err as Error).message,
    });
    return null;
  }
}
