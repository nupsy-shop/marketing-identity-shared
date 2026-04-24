/**
 * Entra ID drift adapter.
 *
 * Encapsulates every Entra-specific query in the drift pipeline:
 * directory lookups, group fetching, JML-scope resolution via
 * entra_group_members for "groups" scope, and federated-domain UPN
 * matching for orphan detection.
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
  is_present_in_idp: boolean;
};
type EntraGroupRow = {
  id: string;
  entra_group_id: string;
  display_name: string;
  email: string | null;
  description: string | null;
  member_count: number;
  is_active: boolean;
};
type GroupMemberRow = { user_email: string };
type DirectoryUserUpnRow = { email: string; user_principal_name: string | null };

/**
 * Post-migration (PR B split is_present_in_idp from is_active):
 *
 *   - is_present_in_idp=false → 'deleted'   (not returned by Graph)
 *   - is_active=false         → 'suspended' (Graph returned accountEnabled=false)
 *   - else                    → 'active'
 *
 * `isActive` keeps its pre-status semantic of `r.is_active` so legacy
 * consumers that haven't adopted `status` see the same behaviour as
 * before the tri-state rollout.
 */
function toDirectoryUser(r: DirectoryUserRow): DirectoryUser {
  const status: 'active' | 'suspended' | 'deleted' =
    !r.is_present_in_idp ? 'deleted'
    : !r.is_active ? 'suspended'
    : 'active';
  return {
    email: r.email,
    displayName: r.display_name,
    department: r.department,
    isActive: r.is_active,
    status,
  };
}

async function findDirectoryUsersByEmails(
  sourceId: string,
  agencyId: string,
  emails: string[],
): Promise<DirectoryUser[]> {
  if (emails.length === 0) return [];
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.entra_directory_users.findMany({
    where: {
      source_id: sourceId,
      agency_id: agencyId,
      email: { in: emails, mode: 'insensitive' as const },
    },
    select: { email: true, display_name: true, department: true, is_active: true, is_present_in_idp: true },
  });
  return rows.map(toDirectoryUser);
}

async function findAllDirectoryUsers(
  sourceId: string,
  agencyId: string,
): Promise<DirectoryUser[]> {
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.entra_directory_users.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: { email: true, display_name: true, department: true, is_active: true, is_present_in_idp: true },
  });
  return rows.map(toDirectoryUser);
}

async function findGroups(
  sourceId: string,
  agencyId: string,
): Promise<ProviderGroup[]> {
  const { prisma } = getRuntime();
  const rows: EntraGroupRow[] = await prisma.entra_groups.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: {
      id: true, entra_group_id: true, display_name: true,
      email: true, description: true, member_count: true, is_active: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    externalId: r.entra_group_id,
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

  // "everyone in the directory" — null signals no filtering
  if (scope.type === 'entire_directory' || scope.type === 'entire_org') {
    return null;
  }

  if (scope.type === 'groups') {
    const ids = scope.groupIds ?? [];
    if (ids.length === 0) return new Set();
    const { prisma } = getRuntime();
    const members: GroupMemberRow[] = await prisma.entra_group_members.findMany({
      where: { group_id: { in: ids }, agency_id: agencyId },
      select: { user_email: true },
    });
    return new Set(members.map((m) => m.user_email.toLowerCase()));
  }

  // GWS-shaped scopes (group / org_units) don't apply to Entra
  return new Set();
}

function resolveJmlScopeGroupIds(scope: JmlScopeShape): string[] {
  if (scope?.type === 'groups' && scope.groupIds) return scope.groupIds;
  return [];
}

async function findFederationOrphans(
  sourceId: string,
  agencyId: string,
  cfg: ConnectionConfigShape,
  excludeEmails: Set<string>,
): Promise<FederationOrphan[]> {
  const domains = (cfg.federatedDomains ?? [])
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  if (domains.length === 0) return [];

  // UPN is the canonical federated-login identifier. Domain split is awkward
  // in Prisma so we fetch and filter in memory — the per-source directory is
  // small enough that this is cheaper than two round-trips.
  const { prisma } = getRuntime();
  const rows: DirectoryUserUpnRow[] = await prisma.entra_directory_users.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: { email: true, user_principal_name: true },
  });

  const domainSet = new Set(domains);

  return rows
    .filter((r) => {
      const upnOrEmail = (r.user_principal_name ?? r.email ?? '').toLowerCase();
      const at = upnOrEmail.lastIndexOf('@');
      if (at < 0) return false;
      const domain = upnOrEmail.slice(at + 1);
      if (!domainSet.has(domain)) return false;
      return !excludeEmails.has((r.email ?? '').toLowerCase());
    })
    .map((r) => {
      const upnOrEmail = (r.user_principal_name ?? r.email ?? '').toLowerCase();
      const domain = upnOrEmail.split('@')[1] ?? '';
      return {
        email: r.email ?? r.user_principal_name ?? '',
        details: `Account lives in federated domain ${domain} but is not tracked as an identity`,
      };
    });
}

function describeFederatedSpace(cfg: ConnectionConfigShape): FederatedSpaceDescriptor {
  const domains = (cfg.federatedDomains ?? []).filter((d) => d.trim().length > 0);
  if (domains.length === 0) return { configured: false, label: '' };
  return { configured: true, label: `Federated domains: ${domains.join(', ')}` };
}

export const entraDriftAdapter: IdentityDriftAdapter = {
  pluginKey: 'entra-id',
  findDirectoryUsersByEmails,
  findAllDirectoryUsers,
  findGroups,
  resolveJmlScopeEmails,
  resolveJmlScopeGroupIds,
  findFederationOrphans,
  describeFederatedSpace,
};
