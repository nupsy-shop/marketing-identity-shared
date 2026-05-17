/**
 * Microsoft Graph API — Directory Sync Helpers
 *
 * Provides paginated fetchers for users, groups, and group members
 * used during Entra ID directory sync operations. Also exports
 * fetchUsersWithMfa which layers MFA enrollment data on top of the
 * base fetchUsers call via Graph $batch on /authentication/methods.
 *
 * No @/ aliases — plain ESM with .js extensions.
 */

import {
  buildBatchRequest,
  chunkBatch,
  parseBatchResponse,
  type MfaClassification,
  type BatchRequest,
  type BatchResponse,
} from './auth-methods.js';

// Re-export BatchResponse so callers (e.g., entra-sync-directory.ts) can
// reference it without importing auth-methods directly.
export type { BatchResponse } from './auth-methods.js';

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

// ---------------------------------------------------------------------------
// fetchUsersWithMfa — fetches users then layers MFA enrollment via $batch
// ---------------------------------------------------------------------------

const ONE_HOUR_MS = 60 * 60 * 1000;
const BATCH_SIZE = 20;
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Case-insensitive header lookup.
 * HTTP headers are case-insensitive per RFC 7230; Graph returns "Retry-After"
 * today but a proxy or future change could alter casing without warning.
 */
function getHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Injectable context for testability (agencyId for logging, now for TTL). */
export interface MfaSyncContext {
  agencyId: string;
  /** Current epoch ms — injectable for deterministic tests. */
  now: number;
}

/** Shape of a user object as seen by fetchUsersWithMfa. */
export interface MfaUser {
  id: string;
  userPrincipalName?: string;
  raw_attributes: Record<string, unknown> & {
    mfa?: { enrolled: boolean; methods: string[]; syncedAt: string };
  };
}

/** Return value of fetchUsersWithMfa. */
export interface MfaSyncResult {
  users: MfaUser[];
  /** True if any inner response returned 403 (UserAuthenticationMethod.Read.All not consented). */
  consentMissing: boolean;
}

/**
 * Interface for the Graph client passed to fetchUsersWithMfa. Kept minimal
 * so callers can inject mocks in tests without wiring the full fetch stack.
 *
 * - fetchUsers() returns the raw user list (id + userPrincipalName + raw_attributes).
 * - batch(req) POSTs to /$batch and returns the response JSON.
 */
export interface GraphMfaClient {
  fetchUsers(): Promise<MfaUser[]>;
  batch(req: BatchRequest): Promise<BatchResponse>;
}

/**
 * Returns true when the user's mfa.syncedAt is within the last hour.
 * A missing or unparseable syncedAt is treated as stale (returns false).
 */
function isMfaFresh(user: MfaUser, nowMs: number): boolean {
  const ts = user.raw_attributes?.mfa?.syncedAt;
  if (!ts) return false;
  const age = nowMs - new Date(ts).getTime();
  return age >= 0 && age < ONE_HOUR_MS;
}

/**
 * Fetch all users via fetchUsers(), then for users whose MFA data is stale
 * or absent, fan out /authentication/methods calls via Graph $batch (20/req,
 * 1h TTL). Persists classification into raw_attributes.mfa.
 *
 * 403 handling: sets consentMissing=true, preserves the user's prior
 *   raw_attributes.mfa (no overwrite). The orchestrator should emit an
 *   entra.mfa_scope_missing audit event and flag the identity source.
 *
 * 429 handling: retries the chunk once. Persistent 429 → skips those users
 *   this run (their mfa.syncedAt stays stale; next run picks them up).
 */
export async function fetchUsersWithMfa(
  client: GraphMfaClient,
  ctx: MfaSyncContext,
): Promise<MfaSyncResult> {
  const users = await client.fetchUsers();

  // Separate fresh (TTL cache hit) from stale users
  const staleUsers = users.filter((u) => !isMfaFresh(u, ctx.now));

  let consentMissing = false;
  const classifications = new Map<string, MfaClassification>();

  if (staleUsers.length > 0) {
    const chunks = chunkBatch(
      staleUsers.map((u) => u.id),
      BATCH_SIZE,
    );

    for (const chunk of chunks) {
      const req = buildBatchRequest(chunk);
      let resp = await client.batch(req);
      let parsed = parseBatchResponse(resp);

      // If any users in this chunk were throttled, honor the Retry-After header
      // from the first throttled inner response, wait up to MAX_RETRY_AFTER_MS,
      // then retry the whole chunk once. Persistent 429 → those users are skipped
      // this run; their mfa.syncedAt stays stale and the next run picks them up.
      if (parsed.throttledFor.length > 0) {
        // Find the largest Retry-After among throttled inner responses (seconds).
        let retryAfterMs = 0;
        for (const r of resp.responses) {
          if (r.status === 429 && getHeader(r.headers, 'Retry-After')) {
            const seconds = parseInt(getHeader(r.headers, 'Retry-After')!, 10);
            if (!isNaN(seconds) && seconds > 0) {
              retryAfterMs = Math.max(retryAfterMs, seconds * 1000);
            }
          }
        }
        const waitMs = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
        if (waitMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        }
        resp = await client.batch(req);
        parsed = parseBatchResponse(resp);
        // After second attempt, throttledFor users are simply skipped — their
        // mfa stays at whatever prior value it had (or undefined).
      }

      if (parsed.consentMissingFor.length > 0) consentMissing = true;

      for (const [id, cls] of parsed.classifications) {
        classifications.set(id, cls);
      }
    }
  }

  const syncedAt = new Date(ctx.now).toISOString();

  // Merge classifications back onto users.
  // - Users with a fresh classification: update raw_attributes.mfa.
  // - Users with no classification (TTL fresh, 403, persistent 429, other error):
  //   keep their existing raw_attributes unchanged.
  const outUsers: MfaUser[] = users.map((u) => {
    const cls = classifications.get(u.id);
    if (!cls) return u; // keep prior mfa (or undefined)
    return {
      ...u,
      raw_attributes: {
        ...u.raw_attributes,
        mfa: { enrolled: cls.enrolled, methods: cls.methods, syncedAt },
      },
    };
  });

  return { users: outUsers, consentMissing };
}
