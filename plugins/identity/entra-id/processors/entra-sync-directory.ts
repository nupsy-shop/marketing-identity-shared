/**
 * Entra ID Sync Directory — Plugin Processor
 *
 * Processes entra_sync_directory Bull jobs. Syncs users, groups, and
 * memberships from Microsoft Entra ID (Azure AD) into the entra_* tables
 * (entra_directory_users, entra_groups, entra_group_members).
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
    const seenEmails = new Set<string>();
    const attributeChanges: Array<{ userExternalId: string; userEmail: string; attribute: string; oldValue: string | null; newValue: string | null }> = [];
    const users = await fetchUsers(accessToken);

    for (const user of users) {
      const email = (user.mail || user.userPrincipalName)?.toLowerCase();
      if (!email) continue;

      // Capture previous state for attribute-change (mover) detection.
      // Principal lifecycle events (joiner/leaver/suspend/unsuspend) are
      // computed post-sync by `jml_detect_lifecycle`, so this processor no
      // longer emits them directly.
      const existingUser = await prisma.entra_directory_users.findFirst({
        where: { source_id: sourceId, entra_user_id: user.id },
        select: { department: true, job_title: true, is_active: true },
      });

      await upsertEntraDirectoryUser(sourceId, tenantId, user);

      // Track attribute changes for mover detection
      if (existingUser) {
        const newDept = user.department || null;
        const newTitle = user.jobTitle || null;
        if (existingUser.department !== newDept && (existingUser.department || newDept)) {
          attributeChanges.push({
            userExternalId: user.id,
            userEmail: email,
            attribute: 'department',
            oldValue: existingUser.department,
            newValue: newDept,
          });
        }
        if (existingUser.job_title !== newTitle && (existingUser.job_title || newTitle)) {
          attributeChanges.push({
            userExternalId: user.id,
            userEmail: email,
            attribute: 'job_title',
            oldValue: existingUser.job_title,
            newValue: newTitle,
          });
        }
      }

      seenEmails.add(email);
      stats.usersUpserted++;
    }

    // 4. Mark users not returned by Graph as inactive.
    // Leaver detection is the job of `jml_detect_lifecycle` which compares
    // the fresh mirror against `integration_identities`.
    const allActiveUsers = await prisma.entra_directory_users.findMany({
      where: { source_id: sourceId, is_active: true },
      select: { email: true },
    });

    const toDeactivateEmails: string[] = [];
    for (const u of allActiveUsers) {
      if (!seenEmails.has(u.email)) {
        toDeactivateEmails.push(u.email);
      }
    }

    if (toDeactivateEmails.length > 0) {
      await prisma.entra_directory_users.updateMany({
        where: { source_id: sourceId, email: { in: toDeactivateEmails }, is_active: true },
        data: { is_active: false, updated_at: new Date(), last_synced_at: new Date() },
      });
      stats.usersDeactivated = toDeactivateEmails.length;
    }

    // 5. Fetch and upsert groups
    const seenGroupIds = new Set<string>(); // entra_group_id values seen this sync
    const groups = await fetchGroups(accessToken);

    for (const group of groups) {
      await upsertEntraGroup(sourceId, tenantId, group);
      seenGroupIds.add(group.id);
      stats.groupsUpserted++;
    }

    // Mark groups not returned by Graph as inactive.
    // Guard: if Graph returned zero groups (API outage / transient failure),
    // seenGroupIds is empty and notIn: [] would deactivate every group.
    if (seenGroupIds.size > 0) {
      await prisma.entra_groups.updateMany({
        where: {
          source_id: sourceId,
          entra_group_id: { notIn: Array.from(seenGroupIds) },
          is_active: true,
        },
        data: { is_active: false, updated_at: new Date(), last_synced_at: new Date() },
      });
    }

    // 6. Fetch and sync group memberships
    const activeGroups = await prisma.entra_groups.findMany({
      where: { source_id: sourceId, is_active: true },
      select: { id: true, entra_group_id: true },
    });

    // groupChanges map: entra_user_id → { added: groupDbId[], removed: groupDbId[] }
    const groupChangesByUser = new Map<string, { added: string[]; removed: string[] }>();

    for (const dbGroup of activeGroups) {
      const members = await fetchGroupMembers(accessToken, dbGroup.entra_group_id);
      const membershipChanges = await syncEntraMemberships(sourceId, dbGroup.id, tenantId, members);
      for (const entraUserId of membershipChanges.addedEntraUserIds) {
        if (!groupChangesByUser.has(entraUserId)) groupChangesByUser.set(entraUserId, { added: [], removed: [] });
        groupChangesByUser.get(entraUserId)!.added.push(dbGroup.id);
      }
      for (const entraUserId of membershipChanges.removedEntraUserIds) {
        if (!groupChangesByUser.has(entraUserId)) groupChangesByUser.set(entraUserId, { added: [], removed: [] });
        groupChangesByUser.get(entraUserId)!.removed.push(dbGroup.id);
      }
      stats.membershipsProcessed += members.length;
    }

    // 7. autoLinkByEmail is disabled — identity_links FK targets directory_users
    // which this sync no longer writes to. Re-enable after Phase 6 migrates
    // identity_links to a polymorphic reference.
    // await autoLinkByEmail(prisma, sourceId);

    // 8. Update source sync status
    await prisma.identity_sources.update({
      where: { id: sourceId },
      data: {
        last_sync_at: new Date(),
        last_sync_status: 'success',
        last_sync_error: null,
        last_sync_stats: { ...stats, attributeChanges: attributeChanges.length > 0 ? attributeChanges : undefined },
        connection_state: 'connected',
        next_sync_at: new Date(Date.now() + (source.sync_interval_hours || 6) * 60 * 60 * 1000),
        updated_at: new Date(),
      },
    });

    if (attributeChanges.length > 0) {
      logger.info('entra_sync_directory: attribute changes detected', {
        tenantId, sourceId, count: attributeChanges.length,
      });
    }
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

    // 10. Chain to jml_detect_lifecycle. Principal lifecycle detection
    //     (joiner/leaver/suspend/unsuspend) runs post-sync as its own job
    //     so it's independently observable and retryable, and skipped
    //     cleanly when the source has no jml_scope configured.
    //
    //     Mover events (group-membership + attribute changes) are computed
    //     DURING sync because they need before/after state, and passed
    //     through as detect's payload. Detect merges them into the event
    //     batch it hands to jml_process_lifecycle.
    const groupChangesPayload = Array.from(groupChangesByUser.entries()).map(
      ([entraUserId, changes]) => {
        const matchedUser = users.find((u) => u.id === entraUserId);
        return {
          userExternalId: entraUserId,
          userEmail: (matchedUser?.mail || matchedUser?.userPrincipalName || '').toLowerCase(),
          added: changes.added,
          removed: changes.removed,
        };
      },
    );

    const { enqueueJob } = getRuntime();
    if (enqueueJob) {
      await enqueueJob('jml_detect_lifecycle', {
        tenantId,
        sourceId,
        pluginKey: 'entra-id',
        triggeredBy: `entra_sync_directory:${job.id}`,
        groupChanges: groupChangesPayload.length > 0 ? groupChangesPayload : undefined,
        attributeChanges: attributeChanges.length > 0 ? attributeChanges : undefined,
      }).catch((err: Error) => {
        logger.error('entra_sync_directory: failed to enqueue jml_detect_lifecycle', {
          tenantId, sourceId, error: err.message,
        });
      });
    }

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

async function upsertEntraDirectoryUser(
  sourceId: string,
  agencyId: string,
  user: EntraUser,
): Promise<void> {
  const { prisma } = getRuntime();
  const email = (user.mail || user.userPrincipalName)?.toLowerCase();
  if (!email) return;

  await prisma.entra_directory_users.upsert({
    where: { source_id_email: { source_id: sourceId, email } },
    update: {
      display_name: user.displayName || email,
      given_name: user.givenName ?? null,
      family_name: user.surname ?? null,
      job_title: user.jobTitle ?? null,
      department: user.department ?? null,
      is_active: user.accountEnabled !== false,
      entra_user_id: user.id,
      user_principal_name: user.userPrincipalName ?? null,
      raw_attributes: user as any,
      updated_at: new Date(),
      last_synced_at: new Date(),
    },
    create: {
      source_id: sourceId,
      email,
      display_name: user.displayName || email,
      given_name: user.givenName ?? null,
      family_name: user.surname ?? null,
      job_title: user.jobTitle ?? null,
      department: user.department ?? null,
      is_active: user.accountEnabled !== false,
      entra_user_id: user.id,
      user_principal_name: user.userPrincipalName ?? null,
      raw_attributes: user as any,
      last_synced_at: new Date(),
      agency_id: agencyId,
    },
  });
}

async function upsertEntraGroup(
  sourceId: string,
  agencyId: string,
  group: EntraGroup,
): Promise<string> {
  const { prisma } = getRuntime();
  const row = await prisma.entra_groups.upsert({
    where: { source_id_entra_group_id: { source_id: sourceId, entra_group_id: group.id } },
    update: {
      display_name: group.displayName || group.id,
      description: group.description ?? null,
      email: group.mail ?? null,
      raw_attributes: group as any,
      updated_at: new Date(),
      last_synced_at: new Date(),
      is_active: true,
    },
    create: {
      source_id: sourceId,
      entra_group_id: group.id,
      display_name: group.displayName || group.id,
      description: group.description ?? null,
      email: group.mail ?? null,
      raw_attributes: group as any,
      last_synced_at: new Date(),
      is_active: true,
      agency_id: agencyId,
    },
  });
  return row.id;
}

async function syncEntraMemberships(
  sourceId: string,
  groupDbId: string,
  agencyId: string,
  members: EntraMember[],
): Promise<{ addedEntraUserIds: string[]; removedEntraUserIds: string[] }> {
  const { prisma } = getRuntime();

  // Resolve each member's email via entra_directory_users (looked up by entra_user_id / Graph GUID).
  // Only members present in our synced users can be tracked.
  // Scoped by source_id + agency_id for defense-in-depth (agency_id is redundant via
  // identity_sources.agency_id FK, but explicit scoping prevents cross-tenant leakage).
  const memberUsers = await prisma.entra_directory_users.findMany({
    where: { source_id: sourceId, agency_id: agencyId, entra_user_id: { in: members.map(m => m.id) } },
    select: { entra_user_id: true, email: true },
  });
  const emailByGraphId = new Map<string, string>(
    memberUsers.map((u: { entra_user_id: string; email: string }) => [u.entra_user_id, u.email]),
  );
  const memberEmails = members
    .map(m => emailByGraphId.get(m.id))
    .filter((e): e is string => Boolean(e));

  // Fetch existing memberships to detect adds
  const existing = await prisma.entra_group_members.findMany({
    where: { group_id: groupDbId },
    select: { user_email: true },
  });
  const existingEmails = new Set<string>(
    existing.map((e: { user_email: string }) => e.user_email),
  );
  const newEmails = memberEmails.filter(e => !existingEmails.has(e));

  // Upsert all current members
  for (const email of memberEmails) {
    await prisma.entra_group_members.upsert({
      where: { group_id_user_email: { group_id: groupDbId, user_email: email } },
      update: { last_synced_at: new Date() },
      create: {
        group_id: groupDbId,
        user_email: email,
        membership_role: 'MEMBER',
        last_synced_at: new Date(),
        agency_id: agencyId,
      },
    });
  }

  // Remove stale members
  const staleEmails = Array.from(existingEmails).filter(e => !memberEmails.includes(e));
  if (staleEmails.length > 0) {
    await prisma.entra_group_members.deleteMany({
      where: { group_id: groupDbId, user_email: { in: staleEmails } },
    });
  }

  // Update member_count
  await prisma.entra_groups.update({
    where: { id: groupDbId },
    data: { member_count: memberEmails.length },
  });

  // Resolve added/removed emails back to entra_user_ids for lifecycle payload
  const allAffectedEmails = [...newEmails, ...staleEmails];
  const affectedUsers = allAffectedEmails.length > 0
    ? await prisma.entra_directory_users.findMany({
        where: { source_id: sourceId, agency_id: agencyId, email: { in: allAffectedEmails } },
        select: { email: true, entra_user_id: true },
      })
    : [];
  const graphIdByEmail = new Map<string, string>(
    affectedUsers.map((u: { email: string; entra_user_id: string }) => [u.email, u.entra_user_id]),
  );
  const addedEntraUserIds = newEmails
    .map(e => graphIdByEmail.get(e))
    .filter((id): id is string => Boolean(id));
  const removedEntraUserIds = staleEmails
    .map(e => graphIdByEmail.get(e))
    .filter((id): id is string => Boolean(id));

  return { addedEntraUserIds, removedEntraUserIds };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function autoLinkByEmail(prisma: any, sourceId: string): Promise<void> {
  // TODO(Phase 6): autoLinkByEmail disabled — identity_links FK targets directory_users
  // which this sync no longer writes to. Re-enable after Phase 6 migrates
  // identity_links to a polymorphic reference.
  //
  // Original implementation read directory_users and wrote identity_links.directory_user_id
  // (hard FK to directory_users.id). Since this processor now writes to entra_directory_users,
  // calling this function would read the wrong table and the FK reference is incompatible.
  // Do NOT delete — Phase 6 cleanup will rewire this.
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
