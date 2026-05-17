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
import { ENTRA_MFA_SCOPE_MISSING } from '../../../../lib/audit/identity-source-events.js';
import { resolveEntraAccessToken } from './resolve-access-token.js';
import {
  fetchUsers,
  fetchGroups,
  fetchGroupMembers,
  fetchUsersWithMfa,
  type EntraUser,
  type EntraGroup,
  type EntraMember,
  type GraphMfaClient,
  type BatchResponse,
} from './api/directory.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: string;
  stats?: SyncStats;
  reason?: string;
}

interface SyncStats {
  usersUpserted: number;
  usersDeactivated: number;
  groupsUpserted: number;
  membershipsProcessed: number;
}

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
      status: 'skipped',
      jobType: 'entra_sync_directory',
      reason: 'no connected Entra ID source',
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
    // Toggle gating — operator-controlled via Settings drawer. Defaults
    // preserve pre-toggle behavior (both true when absent from config).
    const connConfig = (source.connection_config || {}) as Record<string, unknown>;
    const syncUsersEnabled = connConfig.syncUsers !== false;
    const syncGroupsEnabled = connConfig.syncGroups !== false;

    if (!syncUsersEnabled && !syncGroupsEnabled) {
      logger.info('entra_sync_directory: both sync types disabled, skipped', {
        jobId: String(job.id), tenantId, sourceId,
      });
      // Still advance next_sync_at so the schedule keeps ticking; operator
      // may re-enable either toggle later without the row being stuck.
      await prisma.identity_sources.update({
        where: { id: sourceId },
        data: {
          last_sync_at: new Date(),
          last_sync_status: 'success',
          last_sync_error: null,
          last_sync_stats: stats,
          next_sync_at: new Date(Date.now() + (source.sync_interval_hours || 6) * 60 * 60 * 1000),
          updated_at: new Date(),
        },
      });
      return {
        status: 'skipped',
        jobType: 'entra_sync_directory',
        reason: 'syncUsers and syncGroups both disabled',
      };
    }

    // 2. Resolve access token via client credentials
    const accessToken = await resolveEntraAccessToken(prisma, source, logger);
    if (!accessToken) {
      throw new Error('Could not obtain Entra ID access token — check client credentials');
    }

    logger.info('entra_sync_directory: starting sync', {
      jobId: String(job.id),
      tenantId,
      sourceId,
      syncUsersEnabled,
      syncGroupsEnabled,
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

    // Declared at top scope so the lifecycle-payload step (10) can read it
    // regardless of which branch ran. Empty when users block is skipped.
    const attributeChanges: Array<{ userExternalId: string; userEmail: string; attribute: string; oldValue: string | null; newValue: string | null }> = [];
    const groupChangesByUser = new Map<string, { added: string[]; removed: string[] }>();
    let users: EntraUser[] = [];

    // 3. Fetch and upsert users
    if (syncUsersEnabled) {
    const seenEmails = new Set<string>();

    // Build a GraphMfaClient adapter that bridges the access-token-based
    // Graph calls with the injectable interface expected by fetchUsersWithMfa.
    // The fetchUsers() call pulls raw_attributes.mfa from the DB for TTL
    // checking; the batch() call fans out /authentication/methods via $batch.
    const mfaClient: GraphMfaClient = {
      async fetchUsers() {
        const graphUsers = await fetchUsers(accessToken);
        // Enrich with current raw_attributes.mfa from DB so TTL check works.
        const dbRows = await prisma.entra_directory_users.findMany({
          where: { source_id: sourceId, agency_id: tenantId },
          select: { entra_user_id: true, raw_attributes: true },
        });
        const mfaByGraphId = new Map<string, unknown>(
          dbRows.map((r: { entra_user_id: string; raw_attributes: unknown }) => [
            r.entra_user_id,
            (r.raw_attributes as Record<string, unknown>)?.mfa,
          ]),
        );
        return graphUsers.map((u) => ({
          id: u.id,
          userPrincipalName: u.userPrincipalName,
          raw_attributes: {
            ...u,
            mfa: mfaByGraphId.get(u.id) as { enrolled: boolean; methods: string[]; syncedAt: string } | undefined,
          },
        }));
      },
      async batch(req) {
        const GRAPH_BATCH = 'https://graph.microsoft.com/v1.0/$batch';
        const res = await fetch(GRAPH_BATCH, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(req),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => 'Unable to read error body');
          throw new Error(`Graph $batch error (${res.status}): ${text.slice(0, 300)}`);
        }
        return res.json() as Promise<import('./api/directory.js').BatchResponse>;
      },
    };

    const syncRunId = `entra_sync_directory:${job.id}`;
    const mfaResult = await fetchUsersWithMfa(mfaClient, { agencyId: tenantId, now: Date.now() });

    // Handle consent-missing: emit audit event only.
    // Consent state is canonical in identity_sources.granted_scopes (written by
    // the OAuth callback). The UI derives the re-consent banner from granted_scopes
    // directly, so we must NOT write a derived flag here — that duplication was
    // the source of a race condition (sync could overwrite a freshly-granted scope
    // before the OAuth callback completed). The audit event is preserved as a
    // runtime operator alarm; it is not the source of truth.
    if (mfaResult.consentMissing) {
      // Users that had a 403 are those without MFA data after the sync.
      const affectedCount = mfaResult.users.filter((u) => !u.raw_attributes.mfa).length;

      publishAuditEvent({
        eventType: ENTRA_MFA_SCOPE_MISSING,
        action: 'scope_missing',
        source: 'entra_sync_directory',
        severity: 'warn',
        actor: { id: null, type: 'system' },
        agency: { id: tenantId },
        resource: { type: 'identity_source', id: sourceId },
        context: { syncRunId, affectedUserCount: affectedCount },
      }).catch((err) => logger.error({ err, tenantId, sourceId }, 'failed to publish entra.mfa_scope_missing audit event'));

      logger.warn('entra_sync_directory: UserAuthenticationMethod.Read.All consent missing — MFA data will not be synced', {
        tenantId, sourceId,
      });
    }

    // Extract the EntraUser shape from mfaResult.users (raw_attributes holds
    // the full Graph user fields we spread in via mfaClient.fetchUsers above).
    // MFA data (raw_attributes.mfa) is passed through to upsertEntraDirectoryUser
    // so it is persisted atomically with the rest of the user record.
    users = mfaResult.users.map((mu) => {
      // raw_attributes was built as { ...graphUser, mfa? }; extract EntraUser fields.
      const ra = mu.raw_attributes as EntraUser & { mfa?: unknown };
      return ra as EntraUser;
    });

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

      // Pass mfa data through so upsertEntraDirectoryUser includes it
      // in raw_attributes (the upsert writes raw_attributes = user as any,
      // so the mfa key carried on the user object is persisted automatically).
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

    // 4. Mark users not returned by Graph as absent from the IdP.
    // Leaver detection is the job of `jml_detect_lifecycle` which compares
    // the fresh mirror against `integration_identities`.
    //
    // Post-PR-B: the sweep flips `is_present_in_idp` (not `is_active`).
    // `is_active` continues to reflect Graph's accountEnabled, so the
    // disabled-vs-deleted distinction is finally preserved in the mirror.
    // PR C then teaches the Entra drift adapter to read this column.
    const allPresentUsers = await prisma.entra_directory_users.findMany({
      where: { source_id: sourceId, is_present_in_idp: true },
      select: { email: true },
    });

    const toMarkAbsentEmails: string[] = [];
    for (const u of allPresentUsers) {
      if (!seenEmails.has(u.email)) {
        toMarkAbsentEmails.push(u.email);
      }
    }

    if (toMarkAbsentEmails.length > 0) {
      await prisma.entra_directory_users.updateMany({
        where: { source_id: sourceId, email: { in: toMarkAbsentEmails }, is_present_in_idp: true },
        data: { is_present_in_idp: false, updated_at: new Date(), last_synced_at: new Date() },
      });
      stats.usersDeactivated = toMarkAbsentEmails.length;
    }
    } // end if (syncUsersEnabled)

    if (syncGroupsEnabled) {
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
    } // end if (syncGroupsEnabled)

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

  // Tri-state DirectoryUser.status migration (PR B):
  //   is_active          → reflects Graph's accountEnabled only (admin
  //                        disable state). True when Graph returns the
  //                        user with accountEnabled !== false.
  //   is_present_in_idp  → whether Graph returned the user at all. Set
  //                        true here on every upsert; set false by the
  //                        not-seen sweep below.
  //
  // Pre-migration, both signals were collapsed into is_active. That
  // prevented the Entra drift adapter from emitting status='deleted',
  // which in turn forced jml_detect_lifecycle to bucket deletions as
  // Suspend rather than Leaver. PR C will wire is_present_in_idp into
  // the adapter; this PR just captures the split so data starts flowing.
  await prisma.entra_directory_users.upsert({
    where: { source_id_email: { source_id: sourceId, email } },
    update: {
      display_name: user.displayName || email,
      given_name: user.givenName ?? null,
      family_name: user.surname ?? null,
      job_title: user.jobTitle ?? null,
      department: user.department ?? null,
      is_active: user.accountEnabled !== false,
      is_present_in_idp: true,
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
      is_present_in_idp: true,
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
