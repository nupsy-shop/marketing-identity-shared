/**
 * Entra ID Sync Directory — Plugin Processor
 *
 * Processes entra_sync_directory Bull jobs. Syncs users, groups, and
 * memberships from Microsoft Entra ID (Azure AD) into the shared
 * directory tables (directory_users, directory_groups, directory_memberships).
 *
 * Mirrors the structure of gws-sync-directory.ts. Uses client credentials
 * (tenant-registered app) for token acquisition, consistent with other
 * Entra ID processors in this plugin.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import {
  fetchUsers,
  fetchGroups,
  fetchGroupMembers,
  type EntraUser,
  type EntraGroup,
  type EntraMember,
} from './api/directory.js';

interface JobResult {
  status: 'completed';
  jobType: string;
  stats: SyncStats;
}

interface SyncStats {
  usersUpserted: number;
  usersDeactivated: number;
  groupsUpserted: number;
  membershipsProcessed: number;
}

const MSFT_TOKEN_URL = 'https://login.microsoftonline.com';

export default async function entraSyncDirectory(job: Bull.Job): Promise<JobResult> {
  const { tenantId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Load Entra ID identity source for this agency.
  // Allow 'connected' AND 'degraded' sources — degraded means a previous sync
  // failed but the connection may still work. Attempting sync is the only way
  // to recover degraded → connected.
  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'entra-id',
      connection_state: { in: ['connected', 'degraded'] },
    },
  });

  if (!source) {
    logger.info('entra_sync_directory: no connected/degraded Entra ID source', {
      jobId: String(job.id),
      tenantId,
    });
    return {
      status: 'completed',
      jobType: 'entra_sync_directory',
      stats: { usersUpserted: 0, usersDeactivated: 0, groupsUpserted: 0, membershipsProcessed: 0 },
    };
  }

  const sourceId = source.id;
  const stats: SyncStats = {
    usersUpserted: 0,
    usersDeactivated: 0,
    groupsUpserted: 0,
    membershipsProcessed: 0,
  };

  try {
    // 2. Resolve access token via client credentials
    const accessToken = await resolveAccessToken(prisma, source, logger);
    if (!accessToken) {
      throw new Error('Could not obtain Entra ID access token — check client credentials');
    }

    logger.info('entra_sync_directory: starting sync', {
      jobId: String(job.id),
      tenantId,
      sourceId,
    });

    publishAuditEvent({
      eventType: 'directory.sync.started',
      source: 'entra_sync_directory',
      severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_source', id: sourceId },
      context: { jobId: String(job.id), syncType: 'full', pluginKey: 'entra-id' },
    }).catch(() => {});

    // 3. Fetch and upsert users
    const seenExternalIds = new Set<string>();
    const users = await fetchUsers(accessToken);

    for (const user of users) {
      await upsertDirectoryUser(prisma, sourceId, tenantId, user);
      seenExternalIds.add(user.id);
      stats.usersUpserted++;
    }

    // 4. Mark users not returned by Graph as inactive
    const allActiveUsers = await prisma.directory_users.findMany({
      where: { source_id: sourceId, is_active: true },
      select: { id: true, external_id: true },
    });

    const toDeactivate = allActiveUsers
      .filter((u: { id: string; external_id: string }) => !seenExternalIds.has(u.external_id))
      .map((u: { id: string }) => u.id);

    if (toDeactivate.length > 0) {
      await prisma.directory_users.updateMany({
        where: { id: { in: toDeactivate } },
        data: { is_active: false, updated_at: new Date() },
      });
      stats.usersDeactivated = toDeactivate.length;
    }

    // 5. Fetch and upsert groups
    const groups = await fetchGroups(accessToken);

    for (const group of groups) {
      await upsertDirectoryGroup(prisma, sourceId, tenantId, group);
      stats.groupsUpserted++;
    }

    // 6. Fetch and sync group memberships
    const activeGroups = await prisma.directory_groups.findMany({
      where: { source_id: sourceId },
      select: { id: true, external_id: true },
    });

    for (const dbGroup of activeGroups) {
      const members = await fetchGroupMembers(accessToken, dbGroup.external_id);
      await syncMemberships(prisma, sourceId, dbGroup.id, tenantId, members);
      stats.membershipsProcessed += members.length;
    }

    // 7. Auto-link directory users to app users by email
    await autoLinkByEmail(prisma, sourceId);

    // 8. Update source sync status
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: {
        last_sync_at: new Date(),
        last_sync_status: 'success',
        last_sync_error: null,
        last_sync_stats: stats,
        connection_state: 'connected',
        next_sync_at: new Date(Date.now() + (source.sync_interval_hours || 6) * 60 * 60 * 1000),
        updated_at: new Date(),
      },
    });

    logger.info('entra_sync_directory: sync completed', {
      jobId: String(job.id),
      tenantId,
      sourceId,
      stats,
    });

    // 9. Publish completion audit event
    publishAuditEvent({
      eventType: 'directory.sync.completed',
      source: 'entra_sync_directory',
      severity: 'info',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_source', id: sourceId },
      context: {
        jobId: String(job.id),
        syncType: 'full',
        pluginKey: 'entra-id',
        ...stats,
      },
    }).catch(() => {});

    return { status: 'completed', jobType: 'entra_sync_directory', stats };
  } catch (err) {
    logger.error('entra_sync_directory: sync failed', {
      jobId: String(job.id),
      tenantId,
      sourceId,
      error: (err as Error).message,
    });

    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: {
        last_sync_at: new Date(),
        last_sync_status: 'failed',
        last_sync_error: (err as Error).message,
        connection_state: 'degraded',
        updated_at: new Date(),
      },
    }).catch(() => {});

    publishAuditEvent({
      eventType: 'directory.sync.failed',
      source: 'entra_sync_directory',
      severity: 'error',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_source', id: sourceId },
      context: {
        jobId: String(job.id),
        syncType: 'full',
        pluginKey: 'entra-id',
        error: (err as Error).message,
        partialStats: stats,
      },
    }).catch(() => {});

    throw err; // Re-throw so Bull retries
  }
}

// ─── DB Helpers ─────────────────────────────────────────────────────────────

async function upsertDirectoryUser(
  prisma: any,
  sourceId: string,
  agencyId: string,
  user: EntraUser,
): Promise<void> {
  const now = new Date();
  const email = (user.mail || user.userPrincipalName).toLowerCase();

  await prisma.directory_users.upsert({
    where: { source_id_external_id: { source_id: sourceId, external_id: user.id } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      external_id: user.id,
      email,
      display_name: user.displayName || email,
      given_name: user.givenName || null,
      family_name: user.surname || null,
      job_title: user.jobTitle || null,
      department: user.department || null,
      is_active: user.accountEnabled !== false,
      is_suspended: user.accountEnabled === false,
      raw_attributes: user as any,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    },
    update: {
      email,
      display_name: user.displayName || email,
      given_name: user.givenName || null,
      family_name: user.surname || null,
      job_title: user.jobTitle || null,
      department: user.department || null,
      is_active: user.accountEnabled !== false,
      is_suspended: user.accountEnabled === false,
      raw_attributes: user as any,
      last_synced_at: now,
      updated_at: now,
    },
  });
}

async function upsertDirectoryGroup(
  prisma: any,
  sourceId: string,
  agencyId: string,
  group: EntraGroup,
): Promise<string> {
  const now = new Date();

  // Determine group_type: 'Microsoft365', 'Security', or null
  let groupType: string | null = null;
  if (group.groupTypes?.includes('Unified')) {
    groupType = 'Microsoft365';
  } else if (group.securityEnabled) {
    groupType = 'Security';
  }

  const row = await prisma.directory_groups.upsert({
    where: { source_id_external_id: { source_id: sourceId, external_id: group.id } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      external_id: group.id,
      display_name: group.displayName || group.id,
      description: group.description || null,
      email: group.mail || null,
      group_type: groupType,
      raw_attributes: group as any,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    },
    update: {
      display_name: group.displayName || group.id,
      description: group.description || null,
      email: group.mail || null,
      group_type: groupType,
      raw_attributes: group as any,
      last_synced_at: now,
      updated_at: now,
    },
  });

  return row.id;
}

async function syncMemberships(
  prisma: any,
  sourceId: string,
  groupDbId: string,
  agencyId: string,
  members: EntraMember[],
): Promise<void> {
  // Build a set of directory_user DB IDs for members that exist in our table
  const seenUserDbIds = new Set<string>();

  for (const member of members) {
    const dbUser = await prisma.directory_users.findUnique({
      where: { source_id_external_id: { source_id: sourceId, external_id: member.id } },
      select: { id: true },
    });

    if (!dbUser) continue; // User not synced yet — skip
    seenUserDbIds.add(dbUser.id);

    await prisma.directory_memberships.upsert({
      where: { user_id_group_id: { user_id: dbUser.id, group_id: groupDbId } },
      create: {
        id: crypto.randomUUID(),
        user_id: dbUser.id,
        group_id: groupDbId,
        agency_id: agencyId,
        membership_type: 'MEMBER',
        last_synced_at: new Date(),
      },
      update: {
        last_synced_at: new Date(),
      },
    });
  }

  // Remove memberships for users no longer in the group
  const existingMemberships = await prisma.directory_memberships.findMany({
    where: { group_id: groupDbId },
    select: { id: true, user_id: true },
  });

  const removedIds = existingMemberships
    .filter((m: { id: string; user_id: string }) => !seenUserDbIds.has(m.user_id))
    .map((m: { id: string }) => m.id);

  if (removedIds.length > 0) {
    await prisma.directory_memberships.deleteMany({ where: { id: { in: removedIds } } });
  }
}

async function autoLinkByEmail(prisma: any, sourceId: string): Promise<void> {
  const dirUsers = await prisma.directory_users.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true, email: true },
  });

  for (const dirUser of dirUsers) {
    const appUser = await prisma.users.findFirst({
      where: { email: dirUser.email, is_active: true },
      select: { id: true },
    });

    if (!appUser) continue;

    const existingLink = await prisma.identity_links.findFirst({
      where: { directory_user_id: dirUser.id, app_user_id: appUser.id },
    });

    if (!existingLink) {
      await prisma.identity_links.create({
        data: {
          id: crypto.randomUUID(),
          directory_user_id: dirUser.id,
          directory_user_email: dirUser.email,
          app_user_id: appUser.id,
          is_active: true,
          link_method: 'email_match',
          linked_at: new Date(),
        },
      });
    } else if (!existingLink.is_active) {
      await prisma.identity_links.update({
        where: { id: existingLink.id },
        data: { is_active: true },
      });
    }
  }
}

// ─── Token Resolution ────────────────────────────────────────────────────────

async function resolveAccessToken(
  prisma: any,
  source: any,
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

      logger.warn('entra_sync_directory: OAuth token expired and could not be refreshed', {
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
      'entra_sync_directory: missing client credentials (tenantId, clientId, clientSecret)',
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
      logger.error('entra_sync_directory: client credentials token request failed', {
        status: res.status,
        error: errorText.slice(0, 300),
      });
      return null;
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    return data.access_token;
  } catch (err) {
    logger.error('entra_sync_directory: token request error', {
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
      logger.error('entra_sync_directory: OAuth token refresh failed', {
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
    logger.error('entra_sync_directory: OAuth refresh error', {
      error: (err as Error).message,
    });
    return null;
  }
}
