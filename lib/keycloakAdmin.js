/**
 * Keycloak Admin API Client — Multi-Realm
 *
 * Uses Master Realm admin credentials (resource-owner password grant) to manage
 * all agency realms. Each exported function requires a `realm` parameter to target
 * the correct agency's Keycloak realm.
 *
 * OWNER PROVISIONING: Agency owners are provisioned as LOCAL Keycloak users
 * (direct credentials via createKeycloakUser with requiredActions: ['UPDATE_PASSWORD']).
 * They are NOT brokered through an external IdP. This ensures the owner can
 * always authenticate directly with Keycloak even if external identity brokers
 * (Okta, Azure AD, etc.) are misconfigured — providing a break-glass login path.
 *
 * Env vars:
 *   KEYCLOAK_ADMIN_BASE_URL         – e.g. https://pam.accesshive.io
 *   KEYCLOAK_MASTER_ADMIN_USER      – e.g. admin (master realm admin)
 *   KEYCLOAK_MASTER_ADMIN_PASSWORD  – master admin password
 *
 * Legacy fallback env vars (deprecated, used when no per-agency realm config):
 *   KEYCLOAK_TARGET_REALM           – e.g. marketing-identity
 *   KEYCLOAK_ADMIN_CLIENT_ID        – e.g. admin-cli
 *   KEYCLOAK_ADMIN_CLIENT_SECRET    – client secret
 */

// ─── Configuration ──────────────────────────────────────────────────────────

const ADMIN_BASE_URL = () => process.env.KEYCLOAK_ADMIN_BASE_URL;

// Master realm admin credentials (preferred for multi-realm)
const MASTER_ADMIN_USER = () => process.env.KEYCLOAK_MASTER_ADMIN_USER;
const MASTER_ADMIN_PASSWORD = () => process.env.KEYCLOAK_MASTER_ADMIN_PASSWORD;

// Legacy single-realm credentials (fallback)
const LEGACY_TARGET_REALM = () => process.env.KEYCLOAK_TARGET_REALM;
const LEGACY_CLIENT_ID = () => process.env.KEYCLOAK_ADMIN_CLIENT_ID;
const LEGACY_CLIENT_SECRET = () => process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;

export function isKeycloakAdminConfigured() {
  // TEST_MODE: always report as configured
  if (process.env.TEST_MODE === 'true') return true;
  const hasMaster = !!(ADMIN_BASE_URL() && MASTER_ADMIN_USER() && MASTER_ADMIN_PASSWORD());
  const hasLegacy = !!(ADMIN_BASE_URL() && LEGACY_TARGET_REALM() && LEGACY_CLIENT_ID() && LEGACY_CLIENT_SECRET());
  return hasMaster || hasLegacy;
}

// ─── Token Cache ────────────────────────────────────────────────────────────

let _cachedToken = null;
let _tokenExpiresAt = 0;
let _tokenMode = null; // 'master' | 'legacy'

/**
 * Obtain an admin access token. Prefers master realm admin credentials
 * (can manage all realms). Falls back to legacy client_credentials grant
 * against the single target realm.
 */
async function getAdminToken() {
  const now = Date.now();
  if (_cachedToken && now < _tokenExpiresAt) {
    return _cachedToken;
  }

  const baseUrl = ADMIN_BASE_URL();

  // Prefer master admin credentials (can manage all realms)
  if (MASTER_ADMIN_USER() && MASTER_ADMIN_PASSWORD()) {
    const tokenUrl = `${baseUrl}/realms/master/protocol/openid-connect/token`;
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: MASTER_ADMIN_USER(),
      password: MASTER_ADMIN_PASSWORD(),
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Keycloak master admin token request failed (${res.status}): ${err}`);
    }

    const data = await res.json();
    _cachedToken = data.access_token;
    _tokenExpiresAt = now + (data.expires_in - 30) * 1000;
    _tokenMode = 'master';
    return _cachedToken;
  }

  // Fallback: legacy client credentials against target realm
  const legacyRealm = LEGACY_TARGET_REALM();
  const tokenUrl = `${baseUrl}/realms/${legacyRealm}/protocol/openid-connect/token`;
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: LEGACY_CLIENT_ID(),
    client_secret: LEGACY_CLIENT_SECRET(),
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Keycloak admin token request failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  _cachedToken = data.access_token;
  _tokenExpiresAt = now + (data.expires_in - 30) * 1000;
  _tokenMode = 'legacy';
  return _cachedToken;
}

// ─── Admin API Helpers ──────────────────────────────────────────────────────

function adminUrl(realm, path) {
  return `${ADMIN_BASE_URL()}/admin/realms/${realm}${path}`;
}

async function adminFetch(realm, path, options = {}) {
  const token = await getAdminToken();
  const url = adminUrl(realm, path);

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  return res;
}

/**
 * Fetch against the global Keycloak admin API (not realm-scoped).
 * Used for creating realms at the top level.
 */
async function globalAdminFetch(path, options = {}) {
  const token = await getAdminToken();
  const url = `${ADMIN_BASE_URL()}/admin${path}`;

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  return res;
}

// ─── User Operations ────────────────────────────────────────────────────────

/**
 * Create a user in Keycloak.
 *
 * TWO MODES:
 *
 * 1. **Human (Local Directory)** — default when `synthetic` is omitted:
 *    - requiredActions: ['UPDATE_PASSWORD'] (forces password set on first login)
 *    - emailVerified: true, enabled: true
 *
 * 2. **Synthetic (PAM identity)** — when `synthetic` metadata is provided:
 *    - requiredActions: [] (no interactive flows — PAM broker strips them anyway)
 *    - emailVerified: true, enabled: true
 *    - Attributes: mih_userType, mih_source, mih_agencyId, mih_identityId, etc.
 *    - Group: PamSyntheticIdentities (ensured + user added post-creation)
 *
 * @param {string} realm – The Keycloak realm name
 * @param {object} params
 * @param {string} params.email     – User's email address
 * @param {string} params.firstName – First name
 * @param {string} params.lastName  – Last name
 * @param {object} [params.synthetic] – If provided, user is treated as a synthetic PAM identity
 * @param {string|null} [params.synthetic.agencyId]
 * @param {string} [params.synthetic.identityId]
 * @param {string} [params.synthetic.identityType] – e.g. 'DEDICATED_IDENTITY', 'SHARED_CREDENTIAL'
 * @param {string} [params.synthetic.platformKey]
 * @param {string} [params.synthetic.clientId]
 * @returns {{ keycloakUserId: string, alreadyExisted: boolean }}
 */
export async function createKeycloakUser(realm, { email, firstName, lastName, synthetic }) {
  // TEST_MODE: skip real Keycloak, return deterministic no-op
  if (process.env.TEST_MODE === 'true') {
    return { keycloakUserId: `test-kc-${email.replace(/[^a-z0-9]/gi, '-')}`, alreadyExisted: false };
  }

  const isSynthetic = !!synthetic;

  // Build attributes for synthetic users (set at creation time)
  const attributes = isSynthetic ? {
    mih_userType: ['synthetic'],
    mih_source: ['marketing-identity'],
    ...(synthetic.agencyId ? { mih_agencyId: [String(synthetic.agencyId)] } : {}),
    ...(synthetic.identityId ? { mih_identityId: [String(synthetic.identityId)] } : {}),
    ...(synthetic.identityType ? { mih_identityType: [String(synthetic.identityType)] } : {}),
    ...(synthetic.platformKey ? { mih_platformKey: [String(synthetic.platformKey)] } : {}),
    ...(synthetic.clientId ? { mih_clientId: [String(synthetic.clientId)] } : {}),
  } : undefined;

  // Keycloak rejects names with hyphens, digits, and most special characters.
  // Sanitize: strip non-letter characters, collapse whitespace, fallback to 'Identity'.
  const sanitizeName = (raw) => {
    if (!raw) return 'Identity';
    const cleaned = raw
      .replace(/[^a-zA-Z\s]/g, ' ')   // replace non-alpha with space
      .replace(/\s+/g, ' ')           // collapse multiple spaces
      .trim();
    return cleaned || 'Identity';
  };

  const payload = {
    username: email,
    email,
    firstName: sanitizeName(firstName),
    lastName: sanitizeName(lastName),
    enabled: true,
    emailVerified: true,
    requiredActions: isSynthetic ? [] : ['UPDATE_PASSWORD'],
    ...(attributes ? { attributes } : {}),
  };

  const res = await adminFetch(realm, '/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (res.status === 409) {
    // User already exists in Keycloak — try to find and return their ID
    const existing = await findKeycloakUserByEmail(realm, email);
    if (existing) {
      // Backfill: if synthetic, ensure group + attributes are set on existing user
      if (isSynthetic) {
        await _tagExistingSyntheticUser(realm, existing.id, synthetic);
      }
      return { keycloakUserId: existing.id, alreadyExisted: true };
    }
    throw new Error(`Keycloak user conflict for ${email} but could not find existing user`);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create Keycloak user ${email} (${res.status}): ${err}`);
  }

  // Keycloak returns the new user's ID in the Location header
  const location = res.headers.get('Location');
  let keycloakUserId;
  if (!location) {
    // Fallback: look up by email
    const created = await findKeycloakUserByEmail(realm, email);
    if (created) {
      keycloakUserId = created.id;
    } else {
      throw new Error(`Created Keycloak user ${email} but could not extract ID`);
    }
  } else {
    keycloakUserId = location.split('/').pop();
  }

  // Post-creation: add synthetic user to PamSyntheticIdentities group
  if (isSynthetic) {
    try {
      const groupId = await ensureSyntheticGroup(realm);
      await addUserToGroup(realm, keycloakUserId, groupId);
    } catch (err) {
      // Invalidate cached group ID so next attempt re-discovers/recreates
      _syntheticGroupIds.delete(realm);
      // Group assignment failed — propagate error so identity is NOT marked as healthy
      console.error(`[KeycloakAdmin] Failed to add synthetic user ${email} to PamSyntheticIdentities group:`, err.message);
      throw new Error(`Keycloak user ${email} created but group assignment failed: ${err.message}`);
    }
  }

  return { keycloakUserId, alreadyExisted: false };
}

/**
 * Backfill group + attributes for an existing synthetic user.
 * Called when createKeycloakUser hits a 409 for a synthetic identity.
 * Non-fatal — logs and continues.
 */
async function _tagExistingSyntheticUser(realm, keycloakUserId, metadata) {
  // Group assignment + attributes are critical — propagate errors
  const groupId = await ensureSyntheticGroup(realm);
  await addUserToGroup(realm, keycloakUserId, groupId);
  await mergeUserAttributes(realm, keycloakUserId, {
    mih_userType: 'synthetic',
    mih_source: 'marketing-identity',
    ...(metadata.agencyId ? { mih_agencyId: metadata.agencyId } : {}),
    ...(metadata.identityId ? { mih_identityId: metadata.identityId } : {}),
    ...(metadata.identityType ? { mih_identityType: metadata.identityType } : {}),
    ...(metadata.platformKey ? { mih_platformKey: metadata.platformKey } : {}),
    ...(metadata.clientId ? { mih_clientId: metadata.clientId } : {}),
  });
}

/**
 * Find a Keycloak user by email.
 * Returns the first exact-match user representation, or null.
 */
export async function findKeycloakUserByEmail(realm, email) {
  const res = await adminFetch(realm, `/users?email=${encodeURIComponent(email)}&exact=true`);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to search Keycloak users (${res.status}): ${err}`);
  }

  const users = await res.json();
  return users.length > 0 ? users[0] : null;
}

/**
 * Get a Keycloak user by their ID.
 */
export async function getKeycloakUser(realm, keycloakUserId) {
  const res = await adminFetch(realm, `/users/${keycloakUserId}`);

  if (res.status === 404) return null;

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to get Keycloak user ${keycloakUserId} (${res.status}): ${err}`);
  }

  return res.json();
}

/**
 * Send a Keycloak "execute actions" email to a user.
 * This triggers the "update password" flow via Keycloak's built-in email.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {string} keycloakUserId – Keycloak user ID
 * @param {string[]} actions – e.g. ['UPDATE_PASSWORD']
 */
export async function sendKeycloakActionsEmail(realm, keycloakUserId, actions = ['UPDATE_PASSWORD']) {
  const res = await adminFetch(realm, `/users/${keycloakUserId}/execute-actions-email`, {
    method: 'PUT',
    body: JSON.stringify(actions),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to send actions email to Keycloak user ${keycloakUserId} (${res.status}): ${err}`);
  }

  return true;
}

/**
 * Disable (or enable) a Keycloak user.
 */
export async function setKeycloakUserEnabled(realm, keycloakUserId, enabled) {
  const res = await adminFetch(realm, `/users/${keycloakUserId}`, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} Keycloak user ${keycloakUserId} (${res.status}): ${err}`);
  }

  return true;
}

/**
 * Delete a Keycloak user (hard delete).
 * Use with caution — prefer disabling instead.
 */
export async function deleteKeycloakUser(realm, keycloakUserId) {
  const res = await adminFetch(realm, `/users/${keycloakUserId}`, {
    method: 'DELETE',
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Failed to delete Keycloak user ${keycloakUserId} (${res.status}): ${err}`);
  }

  return true;
}

/**
 * Delete an entire Keycloak realm (used by agency teardown).
 * Uses global admin API: DELETE /admin/realms/{realm}
 * Idempotent — returns true even if realm doesn't exist (404).
 */
export async function deleteKeycloakRealm(realm) {
  if (process.env.TEST_MODE === 'true') return true;

  const res = await globalAdminFetch(`/realms/${realm}`, {
    method: 'DELETE',
  });

  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error(`Failed to delete Keycloak realm "${realm}" (${res.status}): ${err}`);
  }

  return true;
}

// ─── Group Management ──────────────────────────────────────────────────────

const SYNTHETIC_GROUP_NAME = 'PamSyntheticIdentities';
const _syntheticGroupIds = new Map(); // realm -> groupId

/**
 * Ensure the PamSyntheticIdentities group exists in the realm.
 * Creates it once if missing. Caches the group ID per-realm for the process lifetime.
 * @param {string} realm – The Keycloak realm name
 * @returns {string} The Keycloak group ID
 */
export async function ensureSyntheticGroup(realm) {
  if (_syntheticGroupIds.has(realm)) return _syntheticGroupIds.get(realm);

  // Search for existing group
  const searchRes = await adminFetch(
    realm,
    `/groups?search=${encodeURIComponent(SYNTHETIC_GROUP_NAME)}&exact=true`
  );
  if (!searchRes.ok) {
    const err = await searchRes.text();
    throw new Error(`Failed to search Keycloak groups (${searchRes.status}): ${err}`);
  }

  const groups = await searchRes.json();
  const match = groups.find(g => g.name === SYNTHETIC_GROUP_NAME);

  if (match) {
    _syntheticGroupIds.set(realm, match.id);
    return match.id;
  }

  // Group doesn't exist — create it
  const createRes = await adminFetch(realm, '/groups', {
    method: 'POST',
    body: JSON.stringify({ name: SYNTHETIC_GROUP_NAME }),
  });

  if (createRes.status === 409) {
    // Race condition: another process created it — search again
    const retryRes = await adminFetch(
      realm,
      `/groups?search=${encodeURIComponent(SYNTHETIC_GROUP_NAME)}&exact=true`
    );
    const retryGroups = retryRes.ok ? await retryRes.json() : [];
    const retryMatch = retryGroups.find(g => g.name === SYNTHETIC_GROUP_NAME);
    if (retryMatch) {
      _syntheticGroupIds.set(realm, retryMatch.id);
      return retryMatch.id;
    }
    throw new Error(`PamSyntheticIdentities group conflict but could not find it`);
  }

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`Failed to create PamSyntheticIdentities group (${createRes.status}): ${err}`);
  }

  // Extract ID from Location header
  const location = createRes.headers.get('Location');
  let groupId;
  if (location) {
    groupId = location.split('/').pop();
  } else {
    // Fallback: search again
    const fallbackRes = await adminFetch(
      realm,
      `/groups?search=${encodeURIComponent(SYNTHETIC_GROUP_NAME)}&exact=true`
    );
    const fallbackGroups = fallbackRes.ok ? await fallbackRes.json() : [];
    const fallbackMatch = fallbackGroups.find(g => g.name === SYNTHETIC_GROUP_NAME);
    if (fallbackMatch) {
      groupId = fallbackMatch.id;
    } else {
      throw new Error('Created PamSyntheticIdentities group but could not resolve its ID');
    }
  }

  _syntheticGroupIds.set(realm, groupId);
  console.log(`[KeycloakAdmin] Created group ${SYNTHETIC_GROUP_NAME} in realm ${realm} (${groupId})`);
  return groupId;
}

/**
 * Add a user to a Keycloak group. Truly idempotent — a 409 (user already
 * in the group) is treated as success so re-provisioning the same identity
 * never fails on group assignment.
 */
async function addUserToGroup(realm, keycloakUserId, groupId) {
  const res = await adminFetch(realm, `/users/${keycloakUserId}/groups/${groupId}`, {
    method: 'PUT',
  });
  if (res.status === 409) {
    // User is already a member of this group — nothing to do.
    console.log(`[KeycloakAdmin] User ${keycloakUserId} already in group ${groupId} — skipping`);
    return;
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to add user ${keycloakUserId} to group ${groupId} (${res.status}): ${err}`);
  }
}

// ─── User Attribute Management ──────────────────────────────────────────────

/**
 * Merge custom attributes onto a Keycloak user without overwriting unrelated ones.
 * Keycloak attributes are { key: [value, ...] } — each value is stored as an array.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {string} keycloakUserId
 * @param {Record<string, string>} attrs — flat key-value map to merge
 */
export async function mergeUserAttributes(realm, keycloakUserId, attrs) {
  // GET full user representation to preserve all fields (email, name, etc.)
  const user = await getKeycloakUser(realm, keycloakUserId);
  if (!user) {
    throw new Error(`Cannot merge attributes — Keycloak user ${keycloakUserId} not found`);
  }

  const existing = user.attributes || {};
  const merged = { ...existing };
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) {
      delete merged[key]; // allow clearing attributes
    } else {
      merged[key] = [String(value)]; // Keycloak stores attribute values as arrays
    }
  }

  // PUT full user representation — partial PUT can wipe fields in Keycloak 26
  const res = await adminFetch(realm, `/users/${keycloakUserId}`, {
    method: 'PUT',
    body: JSON.stringify({ ...user, attributes: merged }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update attributes for user ${keycloakUserId} (${res.status}): ${err}`);
  }
}

// ─── Synthetic Identity Tagging ─────────────────────────────────────────────

/**
 * Tag a Keycloak user as a synthetic identity: add to PamSyntheticIdentities
 * group and set mih_* user attributes. Idempotent and non-fatal.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {string} keycloakUserId — The Keycloak user ID
 * @param {object} metadata
 * @param {string|null} metadata.agencyId
 * @param {string} metadata.identityId — Internal identity record ID
 * @param {string} [metadata.identityType] — e.g. 'DEDICATED_IDENTITY', 'SHARED_CREDENTIAL'
 * @param {string} [metadata.platformKey] — e.g. 'salesforce'
 * @param {string} [metadata.clientId]
 * @returns {{ tagged: boolean, error?: string }}
 */
export async function tagSyntheticIdentity(realm, keycloakUserId, metadata) {
  try {
    // 1. Ensure group exists and add user
    const groupId = await ensureSyntheticGroup(realm);
    await addUserToGroup(realm, keycloakUserId, groupId);

    // 2. Build and merge attributes
    const attrs = {
      mih_userType: 'synthetic',
      mih_source: 'marketing-identity',
      mih_agencyId: metadata.agencyId || null,
      mih_identityId: metadata.identityId,
    };
    if (metadata.identityType) attrs.mih_identityType = metadata.identityType;
    if (metadata.platformKey) attrs.mih_platformKey = metadata.platformKey;
    if (metadata.clientId) attrs.mih_clientId = metadata.clientId;

    await mergeUserAttributes(realm, keycloakUserId, attrs);

    return { tagged: true };
  } catch (err) {
    console.warn(`[KeycloakAdmin] tagSyntheticIdentity failed for ${keycloakUserId}:`, err.message);
    return { tagged: false, error: err.message };
  }
}

// ─── SAML Client Configuration ──────────────────────────────────────────────

/**
 * Update (or create) the Keycloak SAML client for Google Workspace SSO.
 *
 * Uses the GET/modify/PUT pattern to safely update the client representation
 * without wiping other fields. If no SAML client exists, creates one.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {object} params
 * @param {string} params.spEntityId – SP Entity ID from Google Admin Console (becomes clientId)
 * @param {string} params.acsUrl     – ACS URL from Google Admin Console
 * @param {string} [params.clientUuid] – Keycloak SAML client UUID (fallback: search by attribute)
 * @returns {{ success: boolean, clientId?: string, error?: string }}
 */
export async function updateSamlClientConfig(realm, { spEntityId, acsUrl, clientUuid }) {
  // 1. Resolve the client UUID
  let uuid = clientUuid;
  if (!uuid) {
    // Search for the Google SAML client by IdP-initiated SSO URL name
    const searchRes = await adminFetch(realm, '/clients?search=true&first=0&max=100');
    if (!searchRes.ok) {
      const err = await searchRes.text();
      throw new Error(`Failed to list Keycloak clients (${searchRes.status}): ${err}`);
    }
    const clients = await searchRes.json();
    const googleClient = clients.find(
      c => c.protocol === 'saml' && c.attributes?.saml_idp_initiated_sso_url_name === 'google'
    );
    if (!googleClient) {
      // No SAML client exists — create one
      return await _createSamlClient(realm, { spEntityId, acsUrl });
    }
    uuid = googleClient.id;
  }

  // 2. GET current client representation
  const getRes = await adminFetch(realm, `/clients/${uuid}`);
  if (!getRes.ok) {
    const err = await getRes.text();
    throw new Error(`Failed to get Keycloak SAML client (${getRes.status}): ${err}`);
  }
  const client = await getRes.json();

  // 3. Modify fields
  client.clientId = spEntityId;
  client.adminUrl = acsUrl;
  client.baseUrl = `/realms/${realm}/protocol/saml/clients/google`;
  client.redirectUris = [acsUrl];
  // Ensure critical attributes are set
  client.attributes = {
    ...(client.attributes || {}),
    'saml_force_name_id_format': 'true',
    'saml_name_id_format': 'email',
    'saml.client.signature': 'false',
  };

  // Ensure pam-browser flow binding is set (critical for PAM identity chooser)
  if (!client.authenticationFlowBindingOverrides?.browser) {
    const pamBrowserFlowId = await _getPamBrowserFlowId(realm);
    if (pamBrowserFlowId) {
      client.authenticationFlowBindingOverrides = {
        ...(client.authenticationFlowBindingOverrides || {}),
        browser: pamBrowserFlowId,
      };
    }
  }

  // 4. PUT back
  const putRes = await adminFetch(realm, `/clients/${uuid}`, {
    method: 'PUT',
    body: JSON.stringify(client),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`Failed to update Keycloak SAML client (${putRes.status}): ${err}`);
  }

  // 5. Ensure all required protocol mappers exist
  await _ensureSamlMappers(realm, uuid);

  return { success: true, clientId: uuid };
}

/**
 * Look up the pam-browser authentication flow ID in a realm.
 * Required for binding SAML clients to the PAM identity chooser flow.
 */
async function _getPamBrowserFlowId(realm) {
  const res = await adminFetch(realm, '/authentication/flows');
  if (!res.ok) {
    console.warn(`[KeycloakAdmin] Failed to list auth flows (${res.status})`);
    return null;
  }
  const flows = await res.json();
  const pamFlow = flows.find(f => f.alias === 'pam-browser');
  return pamFlow?.id || null;
}

/**
 * Ensure all required SAML protocol mappers exist on a client.
 * Idempotent — skips mappers that already exist by name.
 */
const REQUIRED_SAML_MAPPERS = [
  {
    name: 'email',
    protocol: 'saml',
    protocolMapper: 'saml-user-attribute-nameid-mapper',
    config: {
      'mapper.nameid.format': 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      'user.attribute': 'email',
    },
  },
  {
    name: 'pamOperator',
    protocol: 'saml',
    protocolMapper: 'saml-user-session-note-mapper',
    config: {
      note: 'pam.operator.username',
      'friendly.name': 'PAM Operator',
      'attribute.name': 'pamOperator',
      'attribute.nameformat': 'Basic',
    },
  },
  {
    name: 'firstName',
    protocol: 'saml',
    protocolMapper: 'saml-user-attribute-mapper',
    config: {
      'user.attribute': 'firstName',
      'friendly.name': 'firstName',
      'attribute.name': 'firstName',
      'attribute.nameformat': 'Basic',
    },
  },
  {
    name: 'lastName',
    protocol: 'saml',
    protocolMapper: 'saml-user-attribute-mapper',
    config: {
      'user.attribute': 'lastName',
      'friendly.name': 'lastName',
      'attribute.name': 'lastName',
      'attribute.nameformat': 'Basic',
    },
  },
];

async function _ensureSamlMappers(realm, clientUuid) {
  try {
    const res = await adminFetch(realm, `/clients/${clientUuid}/protocol-mappers/models`);
    if (!res.ok) return;
    const existing = await res.json();
    const existingNames = new Set(existing.map(m => m.name));

    for (const mapper of REQUIRED_SAML_MAPPERS) {
      if (existingNames.has(mapper.name)) continue;
      await adminFetch(realm, `/clients/${clientUuid}/protocol-mappers/models`, {
        method: 'POST',
        body: JSON.stringify(mapper),
      });
    }
  } catch (err) {
    console.warn(`[KeycloakAdmin] SAML mapper reconciliation failed (non-fatal):`, err.message);
  }
}

/**
 * Create a new SAML client for Google Workspace IdP-initiated SSO.
 * Used by updateSamlClientConfig when no SAML client exists in the realm.
 *
 * CRITICAL: Binds the client to the pam-browser auth flow via
 * authenticationFlowBindingOverrides.browser. Without this, SSO uses
 * the default browser flow and the PAM identity chooser never appears.
 */
async function _createSamlClient(realm, { spEntityId, acsUrl }) {
  // Look up pam-browser flow ID — required for correct SSO auth flow
  const pamBrowserFlowId = await _getPamBrowserFlowId(realm);
  if (!pamBrowserFlowId) {
    console.warn('[KeycloakAdmin] pam-browser flow not found — SAML client will use default browser flow');
  }

  const samlClient = {
    clientId: spEntityId,
    protocol: 'saml',
    enabled: true,
    fullScopeAllowed: true,
    frontchannelLogout: true,
    adminUrl: acsUrl,
    baseUrl: `/realms/${realm}/protocol/saml/clients/google`,
    redirectUris: [acsUrl],
    attributes: {
      'saml_idp_initiated_sso_url_name': 'google',
      'saml.force.post.binding': 'true',
      'saml.server.signature': 'true',
      'saml.client.signature': 'false',
      'saml_name_id_format': 'email',
      'saml_force_name_id_format': 'true',
      'saml.assertion.signature': 'true',
      'saml.signature.algorithm': 'RSA_SHA256',
    },
    ...(pamBrowserFlowId && {
      authenticationFlowBindingOverrides: {
        browser: pamBrowserFlowId,
      },
    }),
  };

  const res = await adminFetch(realm, '/clients', {
    method: 'POST',
    body: JSON.stringify(samlClient),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create Google SAML client in realm ${realm} (${res.status}): ${err}`);
  }

  // Extract client UUID from Location header
  const location = res.headers.get('Location');
  const uuid = location ? location.split('/').pop() : null;

  // Add all required protocol mappers
  if (uuid) {
    await _ensureSamlMappers(realm, uuid);
  }

  return { success: true, clientId: uuid };
}

/**
 * Verify the Keycloak SAML client for Google Workspace SSO matches the expected config.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {object} params
 * @param {string} params.spEntityId – Expected SP Entity ID (becomes clientId)
 * @param {string} params.acsUrl     – Expected ACS URL
 * @returns {{ verified: boolean, reason?: string }}
 */
export async function verifySamlClient(realm, { spEntityId, acsUrl }) {
  const searchRes = await adminFetch(realm, '/clients?search=true&first=0&max=100');
  if (!searchRes.ok) {
    const err = await searchRes.text();
    throw new Error(`Failed to list Keycloak clients (${searchRes.status}): ${err}`);
  }
  const clients = await searchRes.json();
  const googleClient = clients.find(
    c => c.protocol === 'saml' && c.attributes?.saml_idp_initiated_sso_url_name === 'google'
  );

  if (!googleClient) {
    return { verified: false, reason: 'No Google SAML client found in Keycloak realm.' };
  }

  if (googleClient.clientId !== spEntityId) {
    return { verified: false, reason: `SP Entity ID mismatch: expected "${spEntityId}", found "${googleClient.clientId}".` };
  }

  const redirectUris = googleClient.redirectUris || [];
  if (!redirectUris.includes(acsUrl)) {
    return { verified: false, reason: `ACS URL mismatch: "${acsUrl}" not in redirect URIs.` };
  }

  if (!googleClient.enabled) {
    return { verified: false, reason: 'SAML client exists but is disabled.' };
  }

  return { verified: true };
}

// ─── Bulk Provisioning ──────────────────────────────────────────────────────

/**
 * Provision multiple local directory users into Keycloak.
 * Returns a results array with per-user success/failure details.
 *
 * @param {string} realm – The Keycloak realm name
 * @param {Array<{id, email, givenName, familyName, displayName}>} localUsers
 * @returns {Array<{localUserId, email, keycloakUserId, success, error, alreadyExisted}>}
 */
export async function bulkProvisionUsers(realm, localUsers) {
  const results = [];

  for (const user of localUsers) {
    try {
      const firstName = user.givenName || user.displayName?.split(' ')[0] || '';
      const lastName = user.familyName || user.displayName?.split(' ').slice(1).join(' ') || '';

      const { keycloakUserId, alreadyExisted } = await createKeycloakUser(realm, {
        email: user.email,
        firstName,
        lastName,
      });

      results.push({
        localUserId: user.id,
        email: user.email,
        keycloakUserId,
        success: true,
        alreadyExisted,
        error: null,
      });
    } catch (err) {
      results.push({
        localUserId: user.id,
        email: user.email,
        keycloakUserId: null,
        success: false,
        alreadyExisted: false,
        error: err.message,
      });
    }
  }

  return results;
}

// ─── Realm Management (for provisioning service) ────────────────────────────

/**
 * Expose globalAdminFetch for use by the realm provisioning service.
 * @param {string} path – e.g. '/realms' (no realm prefix needed)
 * @param {object} options – fetch options
 */
export { globalAdminFetch, adminFetch };
