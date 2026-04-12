/**
 * GWS Sync Directory — Plugin Processor
 *
 * Processes gws_sync_directory Bull jobs. Syncs users, groups, and
 * memberships from Google Workspace into the canonical directory tables.
 *
 * This processor handles the full directory sync that was previously
 * only triggered via the web app's sync-engine. Running it as a job
 * ensures groups and memberships stay up to date on a schedule.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';
import {
  fetchUsers,
  fetchGroups,
  fetchGroupMembers,
  type GoogleUser,
  type GoogleGroup,
  type GoogleMember,
} from './api/directory.js';

interface JobResult {
  status: 'completed';
  jobType: string;
  stats: SyncStats;
}

interface SyncStats {
  usersUpserted: number;
  groupsUpserted: number;
  membershipsProcessed: number;
}

export default async function gwsSyncDirectory(job: Bull.Job): Promise<JobResult> {
  const { tenantId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Load GWS identity source for this agency
  // Allow both 'connected' AND 'degraded' sources to attempt sync.
  // A degraded source is one where a previous sync failed — the connection
  // may still be valid (token works, scopes OK). Running sync again is the
  // only way to recover from degraded → connected. Without this, a single
  // transient failure permanently locks the source out of sync.
  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'google-workspace',
      connection_state: { in: ['connected', 'degraded'] },
    },
  });

  if (!source) {
    logger.info('gws_sync_directory: no connected/degraded GWS source', { jobId: String(job.id), tenantId });
    return { status: 'completed', jobType: 'gws_sync_directory', stats: { usersUpserted: 0, groupsUpserted: 0, membershipsProcessed: 0 } };
  }

  const sourceId = source.id;
  const stats: SyncStats = { usersUpserted: 0, groupsUpserted: 0, membershipsProcessed: 0 };

  try {
  // 2. Resolve OAuth access token
  const accessToken = await resolveAccessToken(prisma, source);
  if (!accessToken) {
    throw new Error('No valid OAuth token for Google Workspace — will retry');
  }

  // 3. Resolve domain
  const connConfig = (source.connection_config || {}) as Record<string, unknown>;
  const domain = (connConfig.primaryDomain as string) || '';
  if (!domain) {
    throw new Error('primaryDomain not configured on GWS identity source');
  }

  logger.info('gws_sync_directory: starting sync', { jobId: String(job.id), tenantId, sourceId, domain });

  publishAuditEvent({
    eventType: 'directory.sync.started',
    source: 'gws_sync_directory',
    severity: 'info',
    actor: { id: null, type: 'system' },
    agency: { id: tenantId },
    resource: { type: 'identity_source', id: sourceId },
    context: { jobId: String(job.id), syncType: 'full', pluginKey: 'google-workspace' },
  }).catch(() => {});

  // 4. Sync users (paginated)
  let userPageToken: string | undefined;
  const seenUserExternalIds = new Set<string>();

  do {
    const page = await fetchUsers(accessToken, domain, userPageToken);
    for (const user of page.users ?? []) {
      await upsertDirectoryUser(prisma, sourceId, tenantId, user);
      seenUserExternalIds.add(user.id);
      stats.usersUpserted++;
    }
    userPageToken = page.nextPageToken;
  } while (userPageToken);

  // Mark users not seen as inactive
  await prisma.directory_users.updateMany({
    where: {
      source_id: sourceId,
      is_active: true,
      external_id: { notIn: Array.from(seenUserExternalIds) },
    },
    data: { is_active: false, updated_at: new Date() },
  });

  // 5. Sync groups (paginated)
  let groupPageToken: string | undefined;

  do {
    const page = await fetchGroups(accessToken, domain, groupPageToken);
    for (const group of page.groups ?? []) {
      await upsertDirectoryGroup(prisma, sourceId, tenantId, group);
      stats.groupsUpserted++;
    }
    groupPageToken = page.nextPageToken;
  } while (groupPageToken);

  // 6. Sync memberships for each group
  const groups = await prisma.directory_groups.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true, external_id: true },
  });

  for (const group of groups) {
    const members: { userId: string; role: string; email: string }[] = [];
    let memberPageToken: string | undefined;

    do {
      const page = await fetchGroupMembers(accessToken, group.external_id, memberPageToken);
      const userMembers = (page.members ?? []).filter((m: GoogleMember) => m.type === 'USER');
      for (const m of userMembers) {
        members.push({ userId: m.id, role: m.role, email: m.email });
      }
      memberPageToken = page.nextPageToken;
    } while (memberPageToken);

    await syncMemberships(prisma, sourceId, group.id, group.external_id, members);
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

  logger.info('gws_sync_directory: sync completed', { jobId: String(job.id), tenantId, sourceId, stats });

  publishAuditEvent({
    eventType: 'directory.sync.completed',
    source: 'gws_sync_directory',
    severity: 'info',
    actor: { id: null, type: 'system' },
    agency: { id: tenantId },
    resource: { type: 'identity_source', id: sourceId },
    context: {
      jobId: String(job.id),
      syncType: 'full',
      pluginKey: 'google-workspace',
      ...stats,
    },
  }).catch(() => {});

  return { status: 'completed', jobType: 'gws_sync_directory', stats };

  } catch (err) {
    logger.error('gws_sync_directory: sync failed', { jobId: String(job.id), tenantId, sourceId, error: (err as Error).message });

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
      source: 'gws_sync_directory',
      severity: 'error',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'identity_source', id: sourceId },
      context: {
        jobId: String(job.id),
        syncType: 'full',
        pluginKey: 'google-workspace',
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
  user: GoogleUser,
): Promise<void> {
  await prisma.directory_users.upsert({
    where: { source_id_external_id: { source_id: sourceId, external_id: user.id } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      external_id: user.id,
      email: user.primaryEmail,
      display_name: user.name?.fullName || user.primaryEmail,
      given_name: user.name?.givenName || null,
      family_name: user.name?.familyName || null,
      is_suspended: user.suspended || false,
      is_active: true,
      avatar_url: user.thumbnailPhotoUrl || null,
      raw_attributes: user as any,
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      email: user.primaryEmail,
      display_name: user.name?.fullName || user.primaryEmail,
      given_name: user.name?.givenName || null,
      family_name: user.name?.familyName || null,
      is_suspended: user.suspended || false,
      is_active: true,
      avatar_url: user.thumbnailPhotoUrl || null,
      raw_attributes: user as any,
      updated_at: new Date(),
    },
  });
}

async function upsertDirectoryGroup(
  prisma: any,
  sourceId: string,
  agencyId: string,
  group: GoogleGroup,
): Promise<void> {
  await prisma.directory_groups.upsert({
    where: { source_id_external_id: { source_id: sourceId, external_id: group.id } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      external_id: group.id,
      display_name: group.name,
      email: group.email,
      description: group.description || null,
      member_count: parseInt(group.directMembersCount || '0', 10),
      group_type: group.adminCreated ? 'admin' : 'user',
      is_active: true,
      raw_attributes: group as any,
      created_at: new Date(),
      updated_at: new Date(),
    },
    update: {
      display_name: group.name,
      email: group.email,
      description: group.description || null,
      member_count: parseInt(group.directMembersCount || '0', 10),
      group_type: group.adminCreated ? 'admin' : 'user',
      is_active: true,
      raw_attributes: group as any,
      updated_at: new Date(),
    },
  });
}

async function syncMemberships(
  prisma: any,
  sourceId: string,
  groupDbId: string,
  groupExternalId: string,
  members: { userId: string; role: string; email: string }[],
): Promise<void> {
  // Get existing memberships for this group
  const existing = await prisma.directory_memberships.findMany({
    where: { group_id: groupDbId },
    select: { id: true, user_external_id: true },
  });
  const existingMap = new Map(existing.map((e: any) => [e.user_external_id, e.id]));

  const seenExternalIds = new Set<string>();

  for (const member of members) {
    seenExternalIds.add(member.userId);

    // Resolve directory user by external ID
    const dirUser = await prisma.directory_users.findFirst({
      where: { source_id: sourceId, external_id: member.userId },
      select: { id: true },
    });

    if (existingMap.has(member.userId)) {
      // Update existing membership
      await prisma.directory_memberships.update({
        where: { id: existingMap.get(member.userId) },
        data: {
          role: member.role,
          user_id: dirUser?.id || null,
          is_active: true,
          updated_at: new Date(),
        },
      });
    } else {
      // Create new membership
      await prisma.directory_memberships.create({
        data: {
          id: crypto.randomUUID(),
          group_id: groupDbId,
          user_external_id: member.userId,
          user_id: dirUser?.id || null,
          email: member.email,
          role: member.role,
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
        },
      });
    }
  }

  // Mark memberships not seen as inactive
  const removedIds = existing
    .filter((e: any) => !seenExternalIds.has(e.user_external_id))
    .map((e: any) => e.id);

  if (removedIds.length > 0) {
    await prisma.directory_memberships.updateMany({
      where: { id: { in: removedIds } },
      data: { is_active: false, updated_at: new Date() },
    });
  }
}

async function autoLinkByEmail(prisma: any, sourceId: string): Promise<void> {
  // Find directory users without an identity link, match by email to app users
  const unlinked = await prisma.directory_users.findMany({
    where: {
      source_id: sourceId,
      is_active: true,
      identity_links: { none: { is_active: true } },
    },
    select: { id: true, email: true },
  });

  for (const dirUser of unlinked) {
    const appUser = await prisma.users.findFirst({
      where: { email: dirUser.email, is_active: true },
      select: { id: true },
    });

    if (appUser) {
      const existingLink = await prisma.identity_links.findFirst({
        where: { directory_user_id: dirUser.id, app_user_id: appUser.id },
      });

      if (!existingLink) {
        await prisma.identity_links.create({
          data: {
            id: crypto.randomUUID(),
            directory_user_id: dirUser.id,
            app_user_id: appUser.id,
            is_active: true,
            link_method: 'email_match',
            created_at: new Date(),
            updated_at: new Date(),
          },
        });
      } else if (!existingLink.is_active) {
        await prisma.identity_links.update({
          where: { id: existingLink.id },
          data: { is_active: true, updated_at: new Date() },
        });
      }
    }
  }
}

// ─── Token Refresh ──────────────────────────────────────────────────────────

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

async function resolveAccessToken(prisma: any, source: any): Promise<string | null> {
  if (!source.oauth_token_id) return null;

  const token = await prisma.oauth_tokens.findUnique({
    where: { id: source.oauth_token_id },
  });

  if (!token || token.isActive === false) return null;

  const expiresAt = token.expiresAt ? new Date(token.expiresAt).getTime() : 0;
  const isExpired = Date.now() > expiresAt - 5 * 60 * 1000;

  if (isExpired && token.refreshToken) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const { logger: log } = getRuntime();
      log.error('gws_sync_directory: GOOGLE_OAUTH_CLIENT_ID/SECRET not configured — cannot refresh token');
      return null;
    }

    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
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
        let errorText = '';
        try { errorText = await res.text(); } catch { /* ignore */ }
        const { logger: log } = getRuntime();
        log.error('gws_sync_directory: Google OAuth token refresh failed', {
          tokenId: token.id,
          status: res.status,
          error: errorText,
        });
        return null;
      }

      const data = await res.json();
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
      const { logger: log } = getRuntime();
      log.error('gws_sync_directory: token refresh error', { error: (err as Error).message });
      return null;
    }
  }

  if (isExpired && !token.refreshToken) {
    const { logger: log } = getRuntime();
    log.error('gws_sync_directory: token expired and no refresh token stored');
    return null;
  }

  return token.accessToken;
}
