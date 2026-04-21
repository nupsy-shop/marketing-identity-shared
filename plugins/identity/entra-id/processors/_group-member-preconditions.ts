/**
 * Shared writeback preconditions for entra_add/remove_group_member.
 * Returns resolved context on success or a skip-with-reason.
 * Consumed only by the writeback flow (payload has localGroupId).
 */

import { getRuntime } from '../../../../lib/runtime.js';

export interface EntraGroupMemberContext {
  userEmail: string;
  entraUserId: string;
  linkedGroupExternalId: string;
  accessToken: string;
  sourceId: string;
}

export type PreconditionResult =
  | { kind: 'ok'; ctx: EntraGroupMemberContext }
  | { kind: 'skip'; reason: string };

export async function loadEntraGroupMemberContext(params: {
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

  const entraGroup = await prisma.entra_groups.findFirst({
    where: { id: params.linkedGroupExternalId, source_id: params.sourceId },
    select: { id: true },
  });
  if (!entraGroup) return { kind: 'skip', reason: 'linked group not found in Entra ID' };

  const entraUser = await prisma.entra_directory_users.findFirst({
    where: { source_id: params.sourceId, email: localUser.email },
    select: { entra_user_id: true },
  });
  if (!entraUser) {
    return { kind: 'skip', reason: `user ${localUser.email} not synced to Entra ID` };
  }

  const source = await prisma.identity_sources.findFirst({
    where: { id: params.sourceId },
    select: { id: true, oauth_token_id: true },
  });
  if (!source || !source.oauth_token_id) {
    return { kind: 'skip', reason: 'source or OAuth token missing' };
  }

  const token = await prisma.oauth_tokens.findUnique({ where: { id: source.oauth_token_id } });
  if (!token || token.isActive === false) {
    return { kind: 'skip', reason: 'OAuth token inactive — reconnect Entra ID' };
  }

  // Token refresh for Entra uses client_credentials against
  // login.microsoftonline.com; reuse existing logic from
  // entra-sync-directory.ts if expired. For brevity and to avoid
  // circular import with sync, we throw on expiry so Bull retries —
  // the next sync cycle will refresh the token via its own flow.
  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    throw new Error('Entra ID OAuth token expired — waiting for next sync to refresh');
  }

  return {
    kind: 'ok',
    ctx: {
      userEmail: localUser.email,
      entraUserId: entraUser.entra_user_id,
      linkedGroupExternalId: params.linkedGroupExternalId,
      accessToken: token.accessToken,
      sourceId: source.id,
    },
  };
}
