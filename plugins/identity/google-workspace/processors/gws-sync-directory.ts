/**
 * GWS Sync Directory — Plugin Processor
 *
 * Processes gws_sync_directory Bull jobs. Syncs users, groups, and
 * memberships from Google Workspace into the GWS-specific source tables
 * (gws_directory_users, gws_groups, gws_group_members).
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
  const seenUserEmails = new Set<string>();

  do {
    const page = await fetchUsers(accessToken, domain, userPageToken);
    for (const user of page.users ?? []) {
      await upsertGwsUser(prisma, sourceId, tenantId, user);
      seenUserEmails.add(user.primaryEmail);
      stats.usersUpserted++;
    }
    userPageToken = page.nextPageToken;
  } while (userPageToken);

  // Mark users not seen as inactive
  const allActiveGws = await prisma.gws_directory_users.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true, email: true },
  });
  const toDeactivate = allActiveGws
    .filter((u: any) => !seenUserEmails.has(u.email))
    .map((u: any) => u.id);
  if (toDeactivate.length > 0) {
    await prisma.gws_directory_users.updateMany({
      where: { id: { in: toDeactivate } },
      data: { is_active: false, updated_at: new Date() },
    });
  }

  // 5. Sync groups (paginated)
  let groupPageToken: string | undefined;
  const groupDbIds = new Map<string, string>(); // googleGroupId -> dbId

  do {
    const page = await fetchGroups(accessToken, domain, groupPageToken);
    for (const group of page.groups ?? []) {
      const groupDbId = await upsertGwsGroup(prisma, sourceId, tenantId, group);
      groupDbIds.set(group.id, groupDbId);
      stats.groupsUpserted++;
    }
    groupPageToken = page.nextPageToken;
  } while (groupPageToken);

  // 6. Sync memberships for each group
  const groups = await prisma.gws_groups.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true, google_group_id: true },
  });

  for (const group of groups) {
    const members: { userId: string; role: string; email: string }[] = [];
    let memberPageToken: string | undefined;

    do {
      const page = await fetchGroupMembers(accessToken, group.google_group_id, memberPageToken);
      const userMembers = (page.members ?? []).filter((m: GoogleMember) => m.type === 'USER');
      for (const m of userMembers) {
        members.push({ userId: m.id, role: m.role, email: m.email });
      }
      memberPageToken = page.nextPageToken;
    } while (memberPageToken);

    await syncGwsMemberships(prisma, group.id, tenantId, members);
    stats.membershipsProcessed += members.length;
  }

  // 6.5 RBAC Drift Detection — find mappings referencing deleted GWS groups
  const activeGwsGroupIds = (await prisma.gws_groups.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true },
  })).map((g: any) => g.id);

  const staleMappings = await prisma.idp_role_mappings.findMany({
    where: {
      agency_id: tenantId,
      source_type: 'gws',
      source_group_id: { notIn: activeGwsGroupIds },
      is_active: true,
    },
    select: { id: true, role: true, source_group_id: true },
  });

  if (staleMappings.length > 0) {
    logger.warn('gws_sync_directory: RBAC drift detected — stale group mappings', {
      tenantId, sourceId,
      staleMappings: staleMappings.map((m: any) => ({ id: m.id, role: m.role, groupId: m.source_group_id })),
    });

    // Mark stale mappings as inactive
    await prisma.idp_role_mappings.updateMany({
      where: { id: { in: staleMappings.map((m: any) => m.id) } },
      data: { is_active: false, updated_at: new Date() },
    });

    publishAuditEvent({
      eventType: 'rbac.drift.detected',
      source: 'gws_sync_directory',
      severity: 'warning',
      actor: { id: null, type: 'system' },
      agency: { id: tenantId },
      resource: { type: 'idp_role_mappings', id: sourceId },
      context: { staleMappingCount: staleMappings.length, staleMappings },
    }).catch(() => {});
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

async function upsertGwsUser(
  prisma: any,
  sourceId: string,
  agencyId: string,
  user: GoogleUser,
): Promise<void> {
  const now = new Date();
  await prisma.gws_directory_users.upsert({
    where: { source_id_email: { source_id: sourceId, email: user.primaryEmail } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      email: user.primaryEmail,
      display_name: user.name?.fullName || user.primaryEmail,
      given_name: user.name?.givenName || null,
      family_name: user.name?.familyName || null,
      is_suspended: user.suspended || false,
      is_active: true,
      google_id: user.id,
      org_unit_path: user.orgUnitPath || null,
      thumbnail_photo_url: user.thumbnailPhotoUrl || null,
      primary_email: user.primaryEmail,
      aliases: user.aliases || null,
      last_login_time: user.lastLoginTime ? new Date(user.lastLoginTime as string) : null,
      creation_time: user.creationTime ? new Date(user.creationTime as string) : null,
      is_admin: user.isAdmin || false,
      is_delegated_admin: user.isDelegatedAdmin || false,
      raw_attributes: user as any,
      last_synced_at: now,
      created_at: now,
      updated_at: now,
    },
    update: {
      display_name: user.name?.fullName || user.primaryEmail,
      given_name: user.name?.givenName || null,
      family_name: user.name?.familyName || null,
      is_suspended: user.suspended || false,
      is_active: true,
      google_id: user.id,
      org_unit_path: user.orgUnitPath || null,
      thumbnail_photo_url: user.thumbnailPhotoUrl || null,
      primary_email: user.primaryEmail,
      aliases: user.aliases || null,
      last_login_time: user.lastLoginTime ? new Date(user.lastLoginTime as string) : null,
      is_admin: user.isAdmin || false,
      is_delegated_admin: user.isDelegatedAdmin || false,
      raw_attributes: user as any,
      last_synced_at: now,
      updated_at: now,
    },
  });
}

async function upsertGwsGroup(
  prisma: any,
  sourceId: string,
  agencyId: string,
  group: GoogleGroup,
): Promise<string> {
  const now = new Date();
  const row = await prisma.gws_groups.upsert({
    where: { source_id_google_group_id: { source_id: sourceId, google_group_id: group.id } },
    create: {
      id: crypto.randomUUID(),
      source_id: sourceId,
      agency_id: agencyId,
      google_group_id: group.id,
      email: group.email,
      display_name: group.name,
      description: group.description || null,
      member_count: parseInt(group.directMembersCount || '0', 10),
      is_active: true,
      raw_attributes: group as any,
      created_at: now,
      updated_at: now,
    },
    update: {
      display_name: group.name,
      email: group.email,
      description: group.description || null,
      member_count: parseInt(group.directMembersCount || '0', 10),
      is_active: true,
      raw_attributes: group as any,
      updated_at: now,
    },
  });
  return row.id;
}

async function syncGwsMemberships(
  prisma: any,
  groupDbId: string,
  agencyId: string,
  members: { userId: string; role: string; email: string }[],
): Promise<void> {
  const existing = await prisma.gws_group_members.findMany({
    where: { group_id: groupDbId },
    select: { id: true, user_email: true },
  });
  const existingMap = new Map(existing.map((e: any) => [e.user_email, e.id]));
  const seenEmails = new Set<string>();

  for (const member of members) {
    seenEmails.add(member.email);
    if (existingMap.has(member.email)) {
      await prisma.gws_group_members.update({
        where: { id: existingMap.get(member.email) },
        data: { membership_role: member.role, last_synced_at: new Date() },
      });
    } else {
      await prisma.gws_group_members.create({
        data: {
          id: crypto.randomUUID(),
          group_id: groupDbId,
          user_email: member.email,
          membership_role: member.role,
          agency_id: agencyId,
          last_synced_at: new Date(),
        },
      });
    }
  }

  // Remove members no longer in group
  const removedIds = existing.filter((e: any) => !seenEmails.has(e.user_email)).map((e: any) => e.id);
  if (removedIds.length > 0) {
    await prisma.gws_group_members.deleteMany({ where: { id: { in: removedIds } } });
  }
}

async function autoLinkByEmail(prisma: any, sourceId: string): Promise<void> {
  const unlinked = await prisma.gws_directory_users.findMany({
    where: { source_id: sourceId, is_active: true },
    select: { id: true, email: true },
  });

  for (const gwsUser of unlinked) {
    const appUser = await prisma.users.findFirst({
      where: { email: gwsUser.email, is_active: true },
      select: { id: true },
    });

    if (appUser) {
      const existingLink = await prisma.identity_links.findFirst({
        where: { directory_user_email: gwsUser.email, app_user_id: appUser.id },
      });

      if (!existingLink) {
        await prisma.identity_links.create({
          data: {
            id: crypto.randomUUID(),
            directory_user_id: gwsUser.id, // Still needed during migration
            directory_user_email: gwsUser.email,
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
