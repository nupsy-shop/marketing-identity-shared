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
 */

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

  const res = await fetch(url, {
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
 * Fetch from the Keycloak Admin REST API scoped to a specific realm.
 * Path is relative to /admin/realms/{realm}, e.g. '/clients', '/users'.
 */
export async function adminFetch(realm: string, path: string, options?: RequestInit): Promise<Response> {
  const token = await getAdminToken();
  const url = `${baseUrl()}/admin/realms/${realm}${path}`;
  return fetch(url, {
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
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
}

// ─── User operations ───────────────────────────────────────────────────────

export async function findKeycloakUserByEmail(realm: string, email: string): Promise<KeycloakUser | null> {
  const res = await adminFetch(realm, `/users?email=${encodeURIComponent(email)}&exact=true`);
  if (!res.ok) return null;
  const users: KeycloakUser[] = await res.json();
  return users.find(u => u.email?.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function getKeycloakUser(realm: string, userId: string): Promise<KeycloakUser | null> {
  const res = await adminFetch(realm, `/users/${userId}`);
  if (!res.ok) return null;
  return res.json();
}

export async function createKeycloakUser(
  user: Partial<KeycloakUser> & { realm?: string },
): Promise<KeycloakUser> {
  const realm = user.realm || 'master';
  const { realm: _r, ...payload } = user;
  const res = await adminFetch(realm, '/users', {
    method: 'POST',
    body: JSON.stringify({ enabled: true, ...payload }),
  });

  if (res.status === 409 && user.email) {
    // User already exists — find and return existing user (idempotent)
    const existing = await findKeycloakUserByEmail(realm, user.email);
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

  const created = await getKeycloakUser(realm, id);
  if (!created) throw new Error(`Created user ${id} but could not fetch it`);
  return created;
}

export async function mergeUserAttributes(
  userId: string,
  attributes: Record<string, string[]>,
  realm = 'master',
): Promise<void> {
  const user = await getKeycloakUser(realm, userId);
  if (!user) throw new Error(`User ${userId} not found`);

  const merged = { ...user.attributes, ...attributes };
  const res = await adminFetch(realm, `/users/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...user, attributes: merged }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update user attributes (${res.status}): ${text}`);
  }
}

export async function tagSyntheticIdentity(userId: string, tag: string, realm = 'master'): Promise<void> {
  await mergeUserAttributes(userId, { synthetic_identity_tag: [tag] }, realm);
}

// ─── SAML client verification ──────────────────────────────────────────────

export async function verifySamlClient(
  realm: string,
  config: { spEntityId: string; acsUrl: string },
): Promise<{ verified: boolean; reason?: string }> {
  const res = await adminFetch(realm, '/clients?search=true&first=0&max=200');
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

// ─── Email actions ─────────────────────────────────────────────────────────

export async function sendKeycloakActionsEmail(
  realm: string,
  userId: string,
  actions: string[] = ['UPDATE_PASSWORD'],
): Promise<void> {
  const res = await adminFetch(realm, `/users/${userId}/execute-actions-email`, {
    method: 'PUT',
    body: JSON.stringify(actions),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to send actions email (${res.status}): ${text}`);
  }
}

// ─── Bulk provisioning ─────────────────────────────────────────────────────

export async function bulkProvisionUsers(
  realm: string,
  users: Array<Partial<KeycloakUser>>,
): Promise<KeycloakUser[]> {
  const results: KeycloakUser[] = [];
  for (const user of users) {
    // Check if user already exists
    if (user.email) {
      const existing = await findKeycloakUserByEmail(realm, user.email);
      if (existing) {
        results.push(existing);
        continue;
      }
    }
    const created = await createKeycloakUser({ ...user, realm });
    results.push(created);
  }
  return results;
}
