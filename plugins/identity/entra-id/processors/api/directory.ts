/**
 * Microsoft Graph API — Directory Sync Helpers
 *
 * Provides paginated fetchers for users, groups, and group members
 * used during Entra ID directory sync operations.
 * No @/ aliases — plain ESM with .js extensions.
 */

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

async function handleGraphError(res: Response): Promise<never> {
  let body: string;
  try {
    body = await res.text();
  } catch {
    body = 'Unable to read error body';
  }
  throw new Error(`Microsoft Graph error (${res.status}): ${body.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface EntraUser {
  id: string;
  displayName: string | null;
  givenName: string | null;
  surname: string | null;
  userPrincipalName: string;
  mail: string | null;
  jobTitle: string | null;
  department: string | null;
  accountEnabled: boolean | null;
  userType: string | null;
  createdDateTime: string | null;
}

export interface EntraGroup {
  id: string;
  displayName: string | null;
  mail: string | null;
  description: string | null;
  groupTypes: string[];
  securityEnabled: boolean | null;
  mailEnabled: boolean | null;
}

export interface EntraMember {
  id: string;
  displayName: string | null;
  userPrincipalName: string;
  mail: string | null;
  accountEnabled: boolean | null;
}

// ---------------------------------------------------------------------------
// Internal pagination helper
// ---------------------------------------------------------------------------

interface ODataPage<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

async function fetchAllPages<T>(
  accessToken: string,
  initialUrl: string,
): Promise<T[]> {
  const results: T[] = [];
  let url: string | undefined = initialUrl;

  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) await handleGraphError(res);

    const page = (await res.json()) as ODataPage<T>;
    results.push(...page.value);
    url = page['@odata.nextLink'];
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public fetchers
// ---------------------------------------------------------------------------

const USER_SELECT = [
  'id',
  'displayName',
  'givenName',
  'surname',
  'userPrincipalName',
  'mail',
  'jobTitle',
  'department',
  'accountEnabled',
  'userType',
  'createdDateTime',
].join(',');

/**
 * GET /users — returns all Member-type users in the tenant.
 * Paginates automatically via @odata.nextLink.
 */
export async function fetchUsers(accessToken: string): Promise<EntraUser[]> {
  const params = new URLSearchParams({
    $filter: "userType eq 'Member'",
    $select: USER_SELECT,
    $top: '999',
  });
  const url = `${GRAPH_BASE}/users?${params.toString()}`;
  return fetchAllPages<EntraUser>(accessToken, url);
}

const GROUP_SELECT = [
  'id',
  'displayName',
  'mail',
  'description',
  'groupTypes',
  'securityEnabled',
  'mailEnabled',
].join(',');

/**
 * GET /groups — returns all groups in the tenant.
 * Paginates automatically via @odata.nextLink.
 */
export async function fetchGroups(accessToken: string): Promise<EntraGroup[]> {
  const params = new URLSearchParams({
    $select: GROUP_SELECT,
    $top: '999',
  });
  const url = `${GRAPH_BASE}/groups?${params.toString()}`;
  return fetchAllPages<EntraGroup>(accessToken, url);
}

// Raw member shape returned by Graph before filtering
interface RawMember {
  '@odata.type': string;
  id: string;
  displayName: string | null;
  userPrincipalName?: string;
  mail: string | null;
  accountEnabled: boolean | null;
}

/**
 * GET /groups/{groupId}/members — returns user-type members of a group.
 * Non-user directory objects (devices, service principals, etc.) are filtered out.
 * Paginates automatically via @odata.nextLink.
 */
export async function fetchGroupMembers(
  accessToken: string,
  groupId: string,
): Promise<EntraMember[]> {
  const params = new URLSearchParams({ $top: '999' });
  const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members?${params.toString()}`;
  const raw = await fetchAllPages<RawMember>(accessToken, url);

  return raw
    .filter((m) => m['@odata.type'] === '#microsoft.graph.user')
    .map((m) => ({
      id: m.id,
      displayName: m.displayName,
      userPrincipalName: m.userPrincipalName ?? '',
      mail: m.mail,
      accountEnabled: m.accountEnabled,
    }));
}
