/**
 * Google Workspace drift adapter.
 *
 * Encapsulates every GWS-specific query in the drift pipeline:
 * directory lookups, group fetching, JML-scope resolution (org_units prefix
 * + single-group membership), and managed-OU federation-orphan detection.
 *
 * Lives in the shared submodule so the Bull worker can consume it. Web-tree
 * code re-exports from this module.
 */

import { getRuntime } from '../../../lib/runtime.js';
import type {
  IdentityDriftAdapter,
  DirectoryUser,
  ProviderGroup,
  FederationOrphan,
  FederatedSpaceDescriptor,
} from '../common/drift-adapter.interface.js';
import type { JmlScopeShape, ConnectionConfigShape } from '../../../lib/identity/drift/types.js';

// Row shapes returned by the queries below. Typed explicitly because the
// shared runtime's `prisma` is `any` (to keep shared decoupled from
// @prisma/client).
type DirectoryUserRow = {
  email: string;
  display_name: string;
  department: string | null;
  is_active: boolean;
  is_suspended: boolean;
};

/**
 * Derive {@link DirectoryUserStatus} from the two GWS mirror columns.
 *
 *   - is_active=false (set by gws_sync_directory when Google didn't return
 *     the user in this pass) → deleted.
 *   - is_suspended=true → suspended (Google Admin suspended the account).
 *   - else → active.
 */
function gwsUserStatus(r: { is_active: boolean; is_suspended: boolean }): 'active' | 'suspended' | 'deleted' {
  if (!r.is_active) return 'deleted';
  if (r.is_suspended) return 'suspended';
  return 'active';
}
type GwsGroupRow = {
  id: string;
  google_group_id: string;
  display_name: string;
  email: string | null;
  description: string | null;
  member_count: number;
  is_active: boolean;
};
type DirectoryUserEmailRow = { email: string };
type DirectoryUserOuRow = { email: string; org_unit_path: string | null };
type GroupMemberRow = { user_email: string };

function toDirectoryUser(r: DirectoryUserRow): DirectoryUser {
  return {
    email: r.email,
    displayName: r.display_name,
    department: r.department,
    // `isActive` keeps its pre-`status` semantic of "row present in mirror
    // with is_active=true" so existing consumers that haven't migrated to
    // `status` see no behavior change. The richer tri-state is exposed via
    // `status` and adopted opt-in by callers that need Suspend vs Leaver
    // disambiguation.
    isActive: r.is_active,
    status: gwsUserStatus(r),
  };
}

async function findDirectoryUsersByEmails(
  sourceId: string,
  agencyId: string,
  emails: string[],
): Promise<DirectoryUser[]> {
  if (emails.length === 0) return [];
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.gws_directory_users.findMany({
    where: {
      source_id: sourceId,
      agency_id: agencyId,
      email: { in: emails, mode: 'insensitive' as const },
    },
    select: { email: true, display_name: true, department: true, is_active: true, is_suspended: true },
  });
  return rows.map(toDirectoryUser);
}

async function findAllDirectoryUsers(
  sourceId: string,
  agencyId: string,
): Promise<DirectoryUser[]> {
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.gws_directory_users.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: { email: true, display_name: true, department: true, is_active: true, is_suspended: true },
  });
  return rows.map(toDirectoryUser);
}

async function findGroups(
  sourceId: string,
  agencyId: string,
): Promise<ProviderGroup[]> {
  const { prisma } = getRuntime();
  const rows: GwsGroupRow[] = await prisma.gws_groups.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: {
      id: true, google_group_id: true, display_name: true,
      email: true, description: true, member_count: true, is_active: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    externalId: r.google_group_id,
    displayName: r.display_name,
    email: r.email,
    description: r.description,
    memberCount: r.member_count,
    isActive: r.is_active,
  }));
}

async function resolveJmlScopeEmails(
  sourceId: string,
  agencyId: string,
  scope: JmlScopeShape,
): Promise<Set<string> | null> {
  if (!scope) return new Set();

  // "everyone in the directory" modes → null signals no filtering
  if (scope.type === 'entire_org' || scope.type === 'entire_directory') {
    return null;
  }

  if (scope.type === 'org_units') {
    const paths = scope.orgUnitPaths ?? [];
    if (paths.length === 0) return new Set();
    const { prisma } = getRuntime();
    const rows: DirectoryUserEmailRow[] = await prisma.gws_directory_users.findMany({
      where: {
        source_id: sourceId,
        agency_id: agencyId,
        OR: paths.map((p) => ({ org_unit_path: { startsWith: p } })),
      },
      select: { email: true },
    });
    return new Set(rows.map((r) => r.email.toLowerCase()));
  }

  if (scope.type === 'group' && scope.groupId) {
    const { prisma } = getRuntime();
    const members: GroupMemberRow[] = await prisma.gws_group_members.findMany({
      where: { group_id: scope.groupId, agency_id: agencyId },
      select: { user_email: true },
    });
    return new Set(members.map((m) => m.user_email.toLowerCase()));
  }

  // 'groups' is Entra-only — GWS returns empty set
  return new Set();
}

function resolveJmlScopeGroupIds(scope: JmlScopeShape): string[] {
  if (scope?.type === 'group' && scope.groupId) return [scope.groupId];
  return [];
}

async function findFederationOrphans(
  sourceId: string,
  agencyId: string,
  cfg: ConnectionConfigShape,
  excludeEmails: Set<string>,
): Promise<FederationOrphan[]> {
  const ouPath = cfg.managedOuPath?.trim();
  if (!ouPath) return [];

  // startsWith covers nested OUs so /Synthetic/AgencyA is still inside
  // /Synthetic. We filter identities client-side because "email NOT IN (...)"
  // is awkward to express in Prisma alongside the prefix condition.
  const { prisma } = getRuntime();
  const rows: DirectoryUserOuRow[] = await prisma.gws_directory_users.findMany({
    where: {
      source_id: sourceId,
      agency_id: agencyId,
      org_unit_path: { startsWith: ouPath },
    },
    select: { email: true, org_unit_path: true },
  });

  return rows
    .filter((r) => !excludeEmails.has(r.email.toLowerCase()))
    .map((r) => ({
      email: r.email,
      details: `Account lives in managed OU ${r.org_unit_path ?? ouPath} but is not tracked as an identity`,
    }));
}

function describeFederatedSpace(cfg: ConnectionConfigShape): FederatedSpaceDescriptor {
  const ouPath = cfg.managedOuPath?.trim();
  if (!ouPath) return { configured: false, label: '' };
  return { configured: true, label: `Managed OU ${ouPath}` };
}

export const gwsDriftAdapter: IdentityDriftAdapter = {
  pluginKey: 'google-workspace',
  findDirectoryUsersByEmails,
  findAllDirectoryUsers,
  findGroups,
  resolveJmlScopeEmails,
  resolveJmlScopeGroupIds,
  findFederationOrphans,
  describeFederatedSpace,
};
