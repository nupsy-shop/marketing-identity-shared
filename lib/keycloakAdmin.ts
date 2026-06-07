/**
 * Keycloak Admin API client.
 *
 * Authenticates via client credentials (KEYCLOAK_ADMIN_CLIENT_ID / SECRET)
 * against the master realm, then issues Admin REST API calls scoped to
 * per-agency realms.
 *
 * Required env vars:
 *   KEYCLOAK_ADMIN_BASE_URL        — e.g. https://pam.accesshive.io
 *   KEYCLOAK_ADMIN_CLIENT_ID       — e.g. marketing-identity-admin
 *   KEYCLOAK_ADMIN_CLIENT_SECRET   — client secret for the admin service account
 *
 * Provider-response override bridge (issue #1072):
 *   Every public function takes an optional trailing `agencyId?: string`.
 *   When set AND the host registered `resolveProviderOverride` on the
 *   shared runtime AND a matching `provider_response_overrides` row exists
 *   for that agency (test tenants only, gated by `agencies.is_test_tenant`
 *   in the host-side resolver), `adminFetch` short-circuits the real HTTP
 *   call with the forced status/body. Callers that omit `agencyId` keep
 *   the previous behaviour exactly. The hook is fail-closed: any error
 *   while consulting the runtime resolver falls through to the real fetch.
 *   `globalAdminFetch` does NOT participate — cross-realm admin ops have
 *   no agency context.
 */

import { getRuntime } from './runtime.js';

export interface KeycloakUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  attributes?: Record<string, string[]>;
  [key: string]: unknown;
}

// ─── Configuration ─────────────────────────────────────────────────────────

function baseUrl(): string | undefined {
  return process.env.KEYCLOAK_ADMIN_BASE_URL;
}

const DEFAULT_ADMIN_TIMEOUT_MS = 15_000;

function adminTimeoutMs(): number {
  const raw = process.env.KEYCLOAK_ADMIN_TIMEOUT_MS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ADMIN_TIMEOUT_MS;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const ms = adminTimeoutMs();
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Keycloak admin request timed out after ${ms}ms: ${url}`);
    }
    throw err;
  }
}

export function isKeycloakAdminConfigured(): boolean {
  return !!(
    process.env.KEYCLOAK_ADMIN_BASE_URL &&
    (
      // Client credentials mode
      (process.env.KEYCLOAK_ADMIN_CLIENT_ID && process.env.KEYCLOAK_ADMIN_CLIENT_SECRET) ||
      // Password grant mode (master admin)
      (process.env.KEYCLOAK_MASTER_ADMIN_USER && process.env.KEYCLOAK_MASTER_ADMIN_PASSWORD)
    )
  );
}

// ─── Token cache ───────────────────────────────────────────────────────────

let _cachedToken: string | null = null;
let _tokenExpiresAt = 0;

async function getAdminToken(): Promise<string> {
  // Return cached token if still valid (with 30s buffer)
  if (_cachedToken && Date.now() < _tokenExpiresAt - 30_000) {
    return _cachedToken;
  }

  const url = `${baseUrl()}/realms/master/protocol/openid-connect/token`;
  let body: URLSearchParams;

  if (process.env.KEYCLOAK_MASTER_ADMIN_USER && process.env.KEYCLOAK_MASTER_ADMIN_PASSWORD) {
    // Password grant (master admin) — preferred for multi-realm access
    body = new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_MASTER_ADMIN_USER,
      password: process.env.KEYCLOAK_MASTER_ADMIN_PASSWORD,
    });
  } else {
    // Client credentials grant
    body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.KEYCLOAK_ADMIN_CLIENT_ID!,
      client_secret: process.env.KEYCLOAK_ADMIN_CLIENT_SECRET!,
    });
  }

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Keycloak admin token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in ?? 300) * 1000;
  return _cachedToken!;
}

// ─── Admin API fetch helpers ───────────────────────────────────────────────

/**
 * Build a synthetic Response matching what `fetch` would return, from a
 * provider-override row. The body is JSON-stringified when present so
 * downstream callers' `res.json()` / `res.text()` continue to work.
 * Returns an empty body for `null`/`undefined` to match Keycloak's habit
 * of returning empty 204s on PUT/DELETE.
 */
function buildOverrideResponse(override: { status: number; body: unknown }): Response {
  const hasBody = override.body !== null && override.body !== undefined;
  const bodyText = hasBody
    ? (typeof override.body === 'string' ? override.body : JSON.stringify(override.body))
    : null;
  return new Response(bodyText, {
    status: override.status,
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
  });
}

/**
 * Consult the host-registered provider-response override resolver. Returns
 * a synthetic Response when an override matches; null otherwise. Fail-
 * closed: any error (uninitialized runtime, resolver throws, etc.) returns
 * null so the caller proceeds to the real fetch.
 */
async function maybeOverrideResponse(url: string, agencyId: string | undefined): Promise<Response | null> {
  if (!agencyId) return null;
  try {
    const runtime = getRuntime();
    const resolver = runtime.resolveProviderOverride;
    if (!resolver) return null;
    const ov = await resolver(agencyId, 'keycloak', url);
    if (!ov) return null;
    if (ov.delayMs && ov.delayMs > 0) {
      await new Promise((r) => setTimeout(r, ov.delayMs));
    }
    return buildOverrideResponse(ov);
  } catch {
    return null;
  }
}

/**
 * Fetch from the Keycloak Admin REST API scoped to a specific realm.
 * Path is relative to /admin/realms/{realm}, e.g. '/clients', '/users'.
 *
 * @param agencyId Optional. When provided AND the host registered a
 *   `resolveProviderOverride` hook on the shared runtime AND a matching
 *   override row exists for the agency, this call short-circuits the real
 *   HTTP request with the forced status/body (test-tenant gating lives in
 *   the host resolver). Omit to preserve pre-#1072 behaviour exactly.
 */
export async function adminFetch(realm: string, path: string, options?: RequestInit, agencyId?: string): Promise<Response> {
  const url = `${baseUrl()}/admin/realms/${realm}${path}`;
  const overrideRes = await maybeOverrideResponse(url, agencyId);
  if (overrideRes) return overrideRes;

  const token = await getAdminToken();
  return fetchWithTimeout(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

/**
 * Fetch from the Keycloak Admin REST API at the server level (no realm scope).
 * Path is relative to /admin, e.g. '/realms', '/serverinfo'.
 */
export async function globalAdminFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = await getAdminToken();
  const url = `${baseUrl()}/admin${path}`;
  return fetchWithTimeout(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

// ─── User operations ───────────────────────────────────────────────────────

export async function findKeycloakUserByEmail(realm: string, email: string, agencyId?: string): Promise<KeycloakUser | null> {
  const res = await adminFetch(realm, `/users?email=${encodeURIComponent(email)}&exact=true`, undefined, agencyId);
  if (!res.ok) return null;
  const users: KeycloakUser[] = await res.json();
  return users.find(u => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function getKeycloakUser(realm: string, userId: string, agencyId?: string): Promise<KeycloakUser | null> {
  const res = await adminFetch(realm, `/users/${userId}`, undefined, agencyId);
  if (!res.ok) return null;
  return res.json();
}

/**
 * List all users in a Keycloak realm. Keycloak's `max=-1` convention returns
 * every user in a single page. Use for drift-detection / full-realm scans.
 * Returns [] on any non-2xx.
 */
export async function listRealmUsers(realm: string, agencyId?: string): Promise<KeycloakUser[]> {
  const res = await adminFetch(realm, '/users?max=-1', undefined, agencyId);
  if (!res.ok) return [];
  return res.json();
}

export async function createKeycloakUser(
  user: Partial<KeycloakUser> & { realm?: string },
  agencyId?: string,
): Promise<KeycloakUser> {
  const realm = user.realm || 'master';
  const { realm: _r, ...payload } = user;
  const res = await adminFetch(realm, '/users', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, ...payload }),
  }, agencyId);

  if (res.status === 409 && user.email) {
    // User already exists — find and return existing user (idempotent)
    const existing = await findKeycloakUserByEmail(realm, user.email, agencyId);
    if (existing) return existing;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create Keycloak user (${res.status}): ${text}`);
  }

  // Keycloak returns Location header with user ID
  const location = res.headers.get('Location');
  const id = location?.split('/').pop();
  if (!id) throw new Error('Keycloak user created but no ID returned');

  const created = await getKeycloakUser(realm, id, agencyId);
  if (!created) throw new Error(`Created user ${id} but could not fetch it`);
  return created;
}

export async function mergeUserAttributes(
  userId: string,
  attributes: Record<string, string[]>,
  realm = 'master',
  agencyId?: string,
): Promise<void> {
  const user = await getKeycloakUser(realm, userId, agencyId);
  if (!user) throw new Error(`User ${userId} not found`);

  const merged = { ...user.attributes, ...attributes };
  const res = await adminFetch(realm, `/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...user, attributes: merged }),
  }, agencyId);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update user attributes (${res.status}): ${text}`);
  }
}

export async function tagSyntheticIdentity(userId: string, tag: string, realm = 'master', agencyId?: string): Promise<void> {
  await mergeUserAttributes(userId, { synthetic_identity_tag: [tag] }, realm, agencyId);
}

// ─── User enable / disable / delete ───────────────────────────────────────

/**
 * Disable a Keycloak user (set enabled=false). User remains in the realm
 * but cannot authenticate. Reversible via enableKeycloakUser.
 */
export async function disableKeycloakUser(realm: string, userId: string, agencyId?: string): Promise<void> {
  const user = await getKeycloakUser(realm, userId, agencyId);
  if (!user) throw new Error(`Keycloak user ${userId} not found in realm ${realm}`);

  const res = await adminFetch(realm, `/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...user, enabled: false }),
  }, agencyId);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to disable Keycloak user (${res.status}): ${text}`);
  }
}

/**
 * Re-enable a previously disabled Keycloak user.
 */
export async function enableKeycloakUser(realm: string, userId: string, agencyId?: string): Promise<void> {
  const user = await getKeycloakUser(realm, userId, agencyId);
  if (!user) throw new Error(`Keycloak user ${userId} not found in realm ${realm}`);

  const res = await adminFetch(realm, `/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...user, enabled: true }),
  }, agencyId);

  if (!res.ok) {
    const text = await res.text();
    // Include realm + userId so the failure is diagnosable from logs +
    // job_runs alone (no need to cross-reference the job payload).
    // Body is appended only when non-empty so the common case of
    // Keycloak returning 5xx with no body doesn't end with ": ".
    throw new Error(
      `Failed to enable Keycloak user ${userId} in realm ${realm} (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
}

/**
 * Hard-delete a Keycloak user from the realm. Irreversible.
 * Used when a user is soft-deleted from the application database.
 */
export async function deleteKeycloakUser(realm: string, userId: string, agencyId?: string): Promise<void> {
  const res = await adminFetch(realm, `/users/${userId}`, {
    method: 'DELETE',
  }, agencyId);

  // 404 = already deleted, treat as success (idempotent)
  if (res.status === 404) return;

  if (!res.ok) {
    const text = await res.text();
    // Include realm + userId so the failure is diagnosable from logs +
    // job_runs alone (no need to cross-reference the job payload).
    // Body is appended only when non-empty so the common case of
    // Keycloak returning 5xx with no body doesn't end with ": ".
    throw new Error(
      `Failed to delete Keycloak user ${userId} in realm ${realm} (${res.status})${text ? `: ${text}` : ''}`,
    );
  }
}

// ─── SAML client verification ──────────────────────────────────────────────

export async function verifySamlClient(
  realm: string,
  config: { spEntityId: string; acsUrl: string },
  agencyId?: string,
): Promise<{ verified: boolean; reason?: string }> {
  const res = await adminFetch(realm, '/clients?search=true&first=0&max=200', undefined, agencyId);
  if (!res.ok) return { verified: false, reason: `Keycloak API error (${res.status})` };

  const clients: Array<Record<string, unknown>> = await res.json();
  const samlClient = clients.find(
    (c) => c.protocol === 'saml' && c.clientId === config.spEntityId,
  );

  if (!samlClient) return { verified: false, reason: `SAML client '${config.spEntityId}' not found` };

  // Check ACS URL in redirectUris
  const redirectUris = (samlClient.redirectUris || []) as string[];
  if (!redirectUris.includes(config.acsUrl) && !redirectUris.includes(config.acsUrl + '/*')) {
    return { verified: false, reason: `ACS URL '${config.acsUrl}' not in client redirect URIs` };
  }

  return { verified: true };
}

/**
 * Delete the Keycloak SAML client that matches `spEntityId`. Idempotent:
 * returns `{ deleted: false }` if the client is already gone (either not
 * in the list, or 404 on DELETE due to a concurrent race).
 *
 * Caller must ensure the realm exists. Throws on non-404 HTTP errors so
 * callers can distinguish transient Keycloak failures from steady state.
 */
export async function deleteKeycloakSamlClient(
  realm: string,
  spEntityId: string,
  agencyId?: string,
): Promise<{ deleted: boolean }> {
  const listRes = await adminFetch(realm, '/clients', undefined, agencyId);
  if (!listRes.ok) {
    throw new Error(`listClients failed: HTTP ${listRes.status}`);
  }
  const clients = (await listRes.json()) as Array<{
    id: string;
    clientId: string;
    protocol: string;
  }>;
  const samlClient = clients.find(
    (c) => c.protocol === 'saml' && c.clientId === spEntityId,
  );
  if (!samlClient) return { deleted: false };

  const delRes = await adminFetch(realm, `/clients/${samlClient.id}`, {
    method: 'DELETE',
  }, agencyId);
  if (delRes.status === 404) return { deleted: false };
  if (!delRes.ok) {
    throw new Error(`deleteClient failed: HTTP ${delRes.status}`);
  }
  return { deleted: true };
}

// ─── Email actions ─────────────────────────────────────────────────────────

export async function sendKeycloakActionsEmail(
  realm: string,
  userId: string,
  actions: string[] = ['UPDATE_PASSWORD'],
  agencyId?: string,
): Promise<void> {
  const res = await adminFetch(realm, `/users/${userId}/execute-actions-email`, {
    method: 'PUT',
    body: JSON.stringify(actions),
  }, agencyId);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to send actions email (${res.status}): ${text}`);
  }
}

// ─── Identity Provider (federation broker) operations ────────────────────
//
// Each agency realm may have 0..1 federated upstream OIDC IdP. The
// reconciliation job (iam_upsert_realm_idp) uses these helpers to
// converge the realm's /identity-provider/instances collection on the
// desired state derived from agency_settings.

export interface RealmIdentityProvider {
  alias: string;
  providerId: string;            // 'oidc' | 'keycloak-oidc' | vendor-specific
  displayName?: string;
  enabled?: boolean;
  config?: Record<string, string>;
  [key: string]: unknown;
}

export async function listRealmIdentityProviders(realm: string, agencyId?: string): Promise<RealmIdentityProvider[]> {
  const res = await adminFetch(realm, '/identity-provider/instances', undefined, agencyId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list identity providers (${res.status}): ${text}`);
  }
  return res.json();
}

export async function getRealmIdentityProvider(realm: string, alias: string, agencyId?: string): Promise<RealmIdentityProvider | null> {
  const res = await adminFetch(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`, undefined, agencyId);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get identity provider ${alias} (${res.status}): ${text}`);
  }
  return res.json();
}

export async function createRealmIdentityProvider(realm: string, idp: RealmIdentityProvider, agencyId?: string): Promise<void> {
  const res = await adminFetch(realm, '/identity-provider/instances', {
    method: 'POST',
    body: JSON.stringify(idp),
  }, agencyId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create identity provider (${res.status}): ${text}`);
  }
}

export async function updateRealmIdentityProvider(realm: string, alias: string, idp: RealmIdentityProvider, agencyId?: string): Promise<void> {
  const res = await adminFetch(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`, {
    method: 'PUT',
    body: JSON.stringify(idp),
  }, agencyId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update identity provider ${alias} (${res.status}): ${text}`);
  }
}

/**
 * Hard-delete an entire Keycloak realm. Irreversible. Callers MUST guard
 * against deleting protected/shared realms (e.g. `agency-trevox`, `master`) —
 * this primitive does not enforce those policies, the job processor does.
 *
 * Idempotent on 404 (realm already gone).
 */
export async function deleteRealm(realm: string, agencyId?: string): Promise<void> {
  const token = await getAdminToken();
  const url = `${baseUrl()}/admin/realms/${realm}`;
  const overrideRes = await maybeOverrideResponse(url, agencyId);
  if (overrideRes) {
    if (overrideRes.status === 404) return;
    if (!overrideRes.ok) {
      const text = await overrideRes.text();
      throw new Error(`Failed to delete realm ${realm} (${overrideRes.status}): ${text}`);
    }
    return;
  }
  const res = await fetchWithTimeout(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete realm ${realm} (${res.status}): ${text}`);
  }
}

export async function deleteRealmIdentityProvider(realm: string, alias: string, agencyId?: string): Promise<void> {
  const res = await adminFetch(realm, `/identity-provider/instances/${encodeURIComponent(alias)}`, {
    method: 'DELETE',
  }, agencyId);
  // 404 — already gone, treat as success (idempotent)
  if (res.status === 404) return;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete identity provider ${alias} (${res.status}): ${text}`);
  }
}

export interface IdentityProviderMapper {
  name: string;
  identityProviderAlias: string;
  identityProviderMapper: string;
  config: Record<string, string>;
}

export async function listIdentityProviderMappers(realm: string, alias: string, agencyId?: string): Promise<IdentityProviderMapper[]> {
  const res = await adminFetch(realm, `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`, undefined, agencyId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to list IdP mappers (${res.status}): ${text}`);
  }
  return res.json();
}

export async function createIdentityProviderMapper(realm: string, alias: string, mapper: IdentityProviderMapper, agencyId?: string): Promise<void> {
  const res = await adminFetch(realm, `/identity-provider/instances/${encodeURIComponent(alias)}/mappers`, {
    method: 'POST',
    body: JSON.stringify(mapper),
  }, agencyId);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create IdP mapper (${res.status}): ${text}`);
  }
}

// ─── Bulk provisioning ─────────────────────────────────────────────────────

export async function bulkProvisionUsers(
  realm: string,
  users: Array<Partial<KeycloakUser>>,
  agencyId?: string,
): Promise<KeycloakUser[]> {
  const results: KeycloakUser[] = [];
  for (const user of users) {
    // Check if user already exists
    if (user.email) {
      const existing = await findKeycloakUserByEmail(realm, user.email, agencyId);
      if (existing) {
        results.push(existing);
        continue;
      }
    }
    const created = await createKeycloakUser({ ...user, realm }, agencyId);
    results.push(created);
  }
  return results;
}
