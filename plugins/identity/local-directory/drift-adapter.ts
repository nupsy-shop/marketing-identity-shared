/**
 * Local Directory drift adapter.
 *
 * "Directory users" for Local Directory are rows in `local_directory_users`,
 * which the platform seeds from Keycloak (the internal IdP). Unlike GWS/Entra,
 * Local Directory has no federated-domain concept — every LD source is fully
 * owned by the platform, so `findFederationOrphans` is always empty and
 * `describeFederatedSpace` reports `configured: false`.
 *
 * Healthy ≡ "the row's corresponding Keycloak user/identity exists". We encode
 * that in `isActive`: a user is only marked active if the LD row is both active
 * (not suspended) AND has a non-null `keycloak_user_id`. This keeps the
 * Identities-tab semantic promised by the page header in sync with drift
 * output — an LD user with no Keycloak link will render as `inactive` drift
 * (which the `local-directory:link_keycloak_identity` remediation then
 * resolves).
 *
 * JML-scope: LD sources aren't currently a JML owner, but we implement the
 * interface defensively so future JML support via local-directory groups
 * works without re-plumbing. `entire_*` returns null; `groups` resolves via
 * `local_directory_group_members`; `org_units` / `group` return empty Sets
 * (LD has no org-unit concept; Entra-style `groups` is the canonical shape).
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
  keycloak_user_id: string | null;
};
type LocalGroupRow = {
  id: string;
  display_name: string;
  description: string | null;
  _count: { local_directory_group_members: number };
};
type GroupMemberUserRow = {
  local_directory_users: { email: string } | null;
};

function toDirectoryUser(r: DirectoryUserRow): DirectoryUser {
  const keycloakLinked = !!r.keycloak_user_id;
  const healthy = r.is_active && !r.is_suspended && keycloakLinked;
  return {
    email: r.email,
    displayName: r.display_name,
    department: r.department,
    // Local Directory "healthy" = active, not suspended, and linked to Keycloak.
    // See file-level doc.
    isActive: healthy,
    // LD is platform-owned — rows only disappear via hard delete, so the
    // adapter never emits `'deleted'`. Suspension, admin-soft-delete, and
    // "not yet provisioned in Keycloak" all collapse to `'suspended'` for
    // JML purposes: none of those states should fire the Leaver workflow
    // (the row isn't gone — it just can't currently log in).
    status: healthy ? 'active' : 'suspended',
  };
}

async function findDirectoryUsersByEmails(
  sourceId: string,
  agencyId: string,
  emails: string[],
): Promise<DirectoryUser[]> {
  if (emails.length === 0) return [];
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.local_directory_users.findMany({
    where: {
      source_id: sourceId,
      agency_id: agencyId,
      email: { in: emails, mode: 'insensitive' as const },
    },
    select: {
      email: true, display_name: true, department: true,
      is_active: true, is_suspended: true, keycloak_user_id: true,
    },
  });
  return rows.map(toDirectoryUser);
}

async function findAllDirectoryUsers(
  sourceId: string,
  agencyId: string,
): Promise<DirectoryUser[]> {
  const { prisma } = getRuntime();
  const rows: DirectoryUserRow[] = await prisma.local_directory_users.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: {
      email: true, display_name: true, department: true,
      is_active: true, is_suspended: true, keycloak_user_id: true,
    },
  });
  return rows.map(toDirectoryUser);
}

async function findGroups(
  sourceId: string,
  agencyId: string,
): Promise<ProviderGroup[]> {
  const { prisma } = getRuntime();
  const rows: LocalGroupRow[] = await prisma.local_directory_groups.findMany({
    where: { source_id: sourceId, agency_id: agencyId },
    select: {
      id: true, display_name: true, description: true,
      _count: { select: { local_directory_group_members: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    // LD has no separate provider-side identifier; the local UUID IS the canonical id.
    externalId: r.id,
    displayName: r.display_name,
    // LD groups don't carry a mail address — keep shape parity by returning null.
    email: null,
    description: r.description,
    memberCount: r._count.local_directory_group_members,
    // LD groups have no soft-delete / deactivation column; existing rows are active.
    isActive: true,
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
    const rows: GroupMemberUserRow[] = await prisma.local_directory_group_members.findMany({
      where: { group_id: { in: ids }, agency_id: agencyId },
      select: { local_directory_users: { select: { email: true } } },
    });
    return new Set(
      rows
        .map((r) => r.local_directory_users?.email?.toLowerCase())
        .filter((e): e is string => !!e),
    );
  }

  // 'group' / 'org_units' aren't valid LD scope shapes — return empty set to
  // match GWS/Entra's defensive behavior for non-applicable scope types.
  return new Set();
}

function resolveJmlScopeGroupIds(scope: JmlScopeShape): string[] {
  if (scope?.type === 'groups' && scope.groupIds) return scope.groupIds;
  if (scope?.type === 'group' && scope.groupId) return [scope.groupId];
  return [];
}

async function findFederationOrphans(
  _sourceId: string,
  _agencyId: string,
  _cfg: ConnectionConfigShape,
  _excludeEmails: Set<string>,
): Promise<FederationOrphan[]> {
  // Local Directory has no federated space. Every LD user is managed by the
  // platform; there is no "users exist in the directory but not as identities"
  // class of drift to surface here.
  return [];
}

function describeFederatedSpace(_cfg: ConnectionConfigShape): FederatedSpaceDescriptor {
  return { configured: false, label: '' };
}

export const localDirectoryDriftAdapter: IdentityDriftAdapter = {
  pluginKey: 'local-directory',
  // LD IS the platform's internal principal registry — every row is a
  // platform-owned user by definition. The GWS/Entra "Out of Scope" bucket
  // doesn't translate here, so every LD directory user matters to the app.
  isPlatformOwnedSource: true,
  findDirectoryUsersByEmails,
  findAllDirectoryUsers,
  findGroups,
  resolveJmlScopeEmails,
  resolveJmlScopeGroupIds,
  findFederationOrphans,
  describeFederatedSpace,
};
