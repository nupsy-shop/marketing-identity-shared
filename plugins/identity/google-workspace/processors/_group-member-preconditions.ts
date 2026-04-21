/**
 * Shared preconditions for gws_add_group_member + gws_remove_group_member.
 * Returns resolved context on success or a skip-with-reason.
 */

import { getRuntime } from '../../../../lib/runtime.js';

export interface GroupMemberContext {
  userEmail: string;
  groupEmail: string;
  accessToken: string;
  sourceId: string;
}

export type PreconditionResult =
  | { kind: 'ok'; ctx: GroupMemberContext }
  | { kind: 'skip'; reason: string };

export async function loadGwsGroupMemberContext(params: {
  tenantId: string;
  sourceId: string;
  userId: string;
  linkedGroupExternalId: string;
}): Promise<PreconditionResult> {
  const { prisma } = getRuntime();

  const localUser = await prisma.local_directory_users.findFirst({
    where: { id: params.userId, agency_id: params.tenantId },
    select: { id: true, email: true },
  });
  if (!localUser) return { kind: 'skip', reason: 'local user not found' };

  const gwsGroup = await prisma.gws_groups.findFirst({
    where: { id: params.linkedGroupExternalId, source_id: params.sourceId },
    select: { id: true, email: true },
  });
  if (!gwsGroup) return { kind: 'skip', reason: 'linked group not found in GWS' };

  const gwsUser = await prisma.gws_directory_users.findFirst({
    where: { source_id: params.sourceId, email: localUser.email },
    select: { id: true },
  });
  if (!gwsUser) {
    return { kind: 'skip', reason: `user ${localUser.email} not synced to Google Workspace` };
  }

  const source = await prisma.identity_sources.findFirst({
    where: { id: params.sourceId },
    select: { id: true, oauth_token_id: true },
  });
  if (!source || !source.oauth_token_id) {
    return { kind: 'skip', reason: 'source or OAuth token missing' };
  }

  // Delegate token refresh to the same helper gws-sync-directory uses. Minimal
  // inline version here because we don't want a circular import with the sync
  // processor. Keep in sync with gws-sync-directory.ts resolveAccessToken.
  const token = await prisma.oauth_tokens.findUnique({ where: { id: source.oauth_token_id } });
  if (!token || token.isActive === false) {
    return { kind: 'skip', reason: 'OAuth token inactive — reconnect Google Workspace' };
  }
  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
  const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;
  let accessToken = token.accessToken;

  if (isExpired && token.refreshToken) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return { kind: 'skip', reason: 'GOOGLE_OAUTH_CLIENT_ID/SECRET not configured' };
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
      throw new Error(`Google Workspace OAuth refresh failed (HTTP ${res.status}) — reconnect source`);
    }
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    accessToken = data.access_token;
    await prisma.oauth_tokens.update({
      where: { id: token.id },
      data: {
        accessToken: data.access_token,
        expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
        updatedAt: new Date(),
      },
    });
  }
  if (isExpired && !token.refreshToken) {
    throw new Error('Google Workspace OAuth expired and no refresh token — reconnect source');
  }

  return {
    kind: 'ok',
    ctx: { userEmail: localUser.email, groupEmail: gwsGroup.email, accessToken, sourceId: source.id },
  };
}
