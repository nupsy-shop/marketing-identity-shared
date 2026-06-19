/**
 * Keycloak Realm Provisioning Service (shared — worker-authoritative).
 *
 * This is the implementation the Bull worker's `iam_provision_realm` processor
 * delegates to (src/processors/iam-provision-realm.ts). It was ported from the
 * web app's `lib/keycloakRealmProvisioning.ts`; the web copy still exists and is
 * used by the synchronous test runner + admin endpoint. The two are intentional
 * near-duplicates today — keep them in sync (or dedupe web onto this) when the
 * provisioning steps change. The only host-specific difference: this version
 * resolves prisma+logger via getRuntime() and writes agency_settings directly,
 * rather than via the web `updateAgencySettings` helper.
 *
 * Auto-provisions a dedicated Keycloak realm for each agency with:
 *   - Realm roles (user, agency_admin, approver, security_admin, breakglass_admin)
 *   - Groups (PamSyntheticIdentities, AgencyAdmins, Approvers, etc.)
 *   - Confidential OIDC client (service account, for platform backend)
 *   - Public PKCE client (for frontend SPA)
 *   - pam-browser authentication flow (cookie + forms + PAM Chooser)
 *
 * Uses the master realm admin token from keycloakAdmin.js.
 *
 * #1072 note: the adminFetch calls in this file intentionally do NOT pass an
 * agencyId — this code path *creates* the realm and its bootstrap objects, so
 * the provider-override hook (which scopes to an already-existing
 * is_test_tenant agency) is not the right gate here. Realm provisioning is a
 * privileged, one-shot bootstrap; test-tenant overrides apply to subsequent
 * day-2 admin operations against the realm, not to realm creation itself.
 */

import { globalAdminFetch, adminFetch, isKeycloakAdminConfigured } from '../../keycloakAdmin.js';
import { getRuntime } from '../../runtime.js';

// Host-agnostic logger shim. The web app and the Bull worker both register a
// logger via setRuntime(); resolve it lazily so this module has no host
// coupling. `error`'s second arg tolerates a bare string (the original web
// code passed `(err as Error).message`) by folding it into the message.
const logger = {
  info: (msg: string, ctx?: Record<string, unknown>) => getRuntime().logger.info(msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => getRuntime().logger.warn(msg, ctx),
  error: (msg: string, extra?: unknown) =>
    getRuntime().logger.error(
      typeof extra === 'string' ? `${msg} ${extra}` : msg,
      extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : undefined,
    ),
};

/**
 * Persist the realm pointer + OIDC client refs onto agency_settings via the
 * host's Prisma client (works in web and the Bull worker).
 *
 * Uses `update` (not `upsert`) keyed by agency_id, matching the sibling
 * iam-delete-realm processor. The settings row always exists when provisioning
 * runs — create-agency creates it before enqueueing the job. `upsert` is wrong
 * here: Prisma validates the `create` branch even when the row exists, and the
 * worker's agency_settings.id has no DB-default in its Prisma schema, so a
 * `create` requires an explicit id and the whole call fails at runtime.
 */
async function writeRealmSettings(agencyId: string, data: Record<string, unknown>): Promise<void> {
  const { prisma } = getRuntime();
  await prisma.agency_settings.update({
    where: { agency_id: agencyId },
    data: { ...data, updated_at: new Date() },
  });
}

// ─── Constants ──────────────────────────────────────────────────────────────

const REALM_ROLES = ['user', 'agency_admin', 'approver', 'security_admin', 'breakglass_admin'];

const GROUPS = [
  { name: 'PamSyntheticIdentities', roles: ['user'] },
  { name: 'AgencyAdmins', roles: ['agency_admin', 'user'] },
  { name: 'Approvers', roles: ['approver', 'user'] },
  { name: 'SecurityAdmins', roles: ['security_admin', 'user'] },
  { name: 'BreakGlassAdmins', roles: ['breakglass_admin', 'user'] },
];

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || 'https://app.accesshive.io';

// ─── Main Provisioning Function ─────────────────────────────────────────────

/**
 * Provision a dedicated Keycloak realm for an agency.
 *
 * @param {string} agencyId - The agency's database ID
 * @param {string} agencySlug - The agency's URL slug (used in realm name)
 * @param {string} agencyName - The agency's display name (used as realm displayName)
 * @returns {{ success: boolean, realmName?: string, error?: string }}
 */
export async function provisionAgencyRealm(agencyId: string, agencySlug: string, agencyName: string) {
  if (!isKeycloakAdminConfigured()) {
    logger.warn('[RealmProvisioning] Keycloak not configured — skipping realm provisioning');
    return { success: false, error: 'Keycloak Admin API is not configured' };
  }

  const realmName = `agency-${agencySlug}`;
  const platformClientId = `${realmName}-platform`;
  const frontendClientId = `${realmName}-frontend`;

  logger.info(`[RealmProvisioning] Starting provisioning for agency "${agencyName}" → realm "${realmName}"`);

  // Track whether THIS run created the realm. Rollback (delete) is only safe
  // for a realm we just created — never for one that already existed (409),
  // which may belong to a real tenant.
  let realmCreatedThisRun = false;

  try {
    // ── Step 1: Create the realm ────────────────────────────────────────
    realmCreatedThisRun = await _createRealm(realmName, agencyName);

    // ── Step 2: Create realm roles ──────────────────────────────────────
    await _createRealmRoles(realmName);

    // ── Step 3: Set default role ────────────────────────────────────────
    await _setDefaultRole(realmName, 'user');

    // ── Step 4: Create groups with role mappings ────────────────────────
    await _createGroups(realmName);

    // ── Step 5: Create confidential OIDC client (platform backend) ──────
    const platformSecret = await _createConfidentialClient(realmName, platformClientId, agencyName);

    // ── Step 6: Create public PKCE client (frontend SPA) ────────────────
    await _createPublicClient(realmName, frontendClientId, agencyName);

    // ── Step 7: Create pam-browser auth flow ────────────────────────────
    await _createPamBrowserFlow(realmName);

    // ── Step 8: Store config in DB ──────────────────────────────────────
    await writeRealmSettings(agencyId, {
      keycloak_realm: realmName,
      keycloak_oidc_client_id: platformClientId,
      keycloak_oidc_client_secret: platformSecret,
      keycloak_frontend_client_id: frontendClientId,
      keycloak_realm_provisioned_at: new Date(),
      keycloak_realm_status: 'active',
    });

    logger.info(`[RealmProvisioning] ✅ Realm "${realmName}" provisioned successfully`);
    return { success: true, realmName };

  } catch (err: unknown) {
    logger.error(`[RealmProvisioning] ❌ Failed to provision realm "${realmName}":`, (err as Error).message);

    // Rollback: delete the partially-created realm so we don't orphan an
    // `agency-<slug>` realm on the shared Keycloak. Only delete a realm we
    // created in this run — a pre-existing realm (409 on create) may hold a
    // real tenant's data and must never be destroyed by a failed retry.
    let rolledBack = false;
    if (realmCreatedThisRun) {
      rolledBack = await _deleteRealm(realmName);
    }

    // Mark as failed in DB so it can be retried. If we rolled the realm back,
    // null the pointer — it no longer exists on Keycloak.
    try {
      await writeRealmSettings(agencyId, {
        keycloak_realm: rolledBack ? null : realmName,
        keycloak_realm_status: 'error',
      });
    } catch (dbErr: unknown) {
      logger.error('[RealmProvisioning] Failed to record error status in DB:', (dbErr as Error).message);
    }

    return { success: false, realmName, error: (err as Error).message };
  }
}

// ─── Step Implementations ───────────────────────────────────────────────────

/**
 * Step 1: Create the Keycloak realm.
 * Returns true if the realm was newly created in this call, false if it
 * already existed (409). The caller uses this to decide whether a failed
 * provisioning run may safely roll back (delete) the realm.
 */
async function _createRealm(realmName: string, displayName: string): Promise<boolean> {
  const realmConfig = {
    realm: realmName,
    displayName: displayName,
    enabled: true,
    loginTheme: 'marketing-identity',
    registrationAllowed: false,
    resetPasswordAllowed: true,
    rememberMe: true,
    loginWithEmailAllowed: true,
    duplicateEmailsAllowed: false,
    verifyEmail: false,
    bruteForceProtected: true,
    maxFailureWaitSeconds: 900,
    failureFactor: 5,
    eventsEnabled: true,
    eventsExpiration: 604800, // 7 days
    adminEventsEnabled: true,
    adminEventsDetailsEnabled: true,
    sslRequired: 'external',
    // Access token lifespan (5 min default)
    accessTokenLifespan: 300,
    // SSO session idle/max
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 36000,
  };

  const res = await globalAdminFetch('/realms', {
    method: 'POST',
    body: JSON.stringify(realmConfig),
  });

  if (res.status === 409) {
    logger.info(`[RealmProvisioning] Realm "${realmName}" already exists — continuing`);
    return false;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create realm "${realmName}" (${res.status}): ${err}`);
  }

  logger.info(`[RealmProvisioning] Created realm "${realmName}"`);
  return true;
}

/**
 * Rollback helper: delete a realm. Used when provisioning fails after the
 * realm was freshly created, to avoid orphaning it on the shared Keycloak.
 * 404 is treated as success (already gone). Returns true if the realm is no
 * longer present after the call; false if the delete failed (logged, non-
 * fatal — the caller still records the error status).
 */
async function _deleteRealm(realmName: string): Promise<boolean> {
  try {
    const res = await globalAdminFetch(`/realms/${realmName}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) {
      logger.info(`[RealmProvisioning] Rolled back realm "${realmName}" after provisioning failure`);
      return true;
    }
    const err = await res.text();
    logger.error(`[RealmProvisioning] Failed to roll back realm "${realmName}" (${res.status}): ${err}`);
    return false;
  } catch (delErr: unknown) {
    logger.error(`[RealmProvisioning] Error while rolling back realm "${realmName}":`, (delErr as Error).message);
    return false;
  }
}

/**
 * Step 2: Create realm-level roles.
 */
async function _createRealmRoles(realmName: string) {
  for (const roleName of REALM_ROLES) {
    const res = await adminFetch(realmName, '/roles', {
      method: 'POST',
      body: JSON.stringify({
        name: roleName,
        description: `Auto-provisioned role: ${roleName}`,
      }),
    });

    if (res.status === 409) {
      // Role already exists
      continue;
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to create role "${roleName}" in realm "${realmName}" (${res.status}): ${err}`);
    }
  }

  logger.info(`[RealmProvisioning] Created ${REALM_ROLES.length} realm roles`);
}

/**
 * Step 3: Set the default role for new users.
 */
async function _setDefaultRole(realmName: string, defaultRoleName: string) {
  // Keycloak 26 uses "default-roles-{realmname}" composite role
  // We need to add our 'user' role to that composite
  const defaultRoleComposite = `default-roles-${realmName}`;

  // Get the composite default role
  const defaultRoleRes = await adminFetch(realmName, `/roles/${encodeURIComponent(defaultRoleComposite)}`);
  if (!defaultRoleRes.ok) {
    logger.warn(`[RealmProvisioning] Could not find default composite role "${defaultRoleComposite}" — skipping default role setup`);
    return;
  }

  // Get the 'user' role representation
  const userRoleRes = await adminFetch(realmName, `/roles/${encodeURIComponent(defaultRoleName)}`);
  if (!userRoleRes.ok) {
    logger.warn(`[RealmProvisioning] Could not find role "${defaultRoleName}" — skipping default role setup`);
    return;
  }
  const userRole = await userRoleRes.json();

  // Add 'user' role as composite of the default role
  const defaultRole = await defaultRoleRes.json();
  const addRes = await adminFetch(realmName, `/roles-by-id/${defaultRole.id}/composites`, {
    method: 'POST',
    body: JSON.stringify([userRole]),
  });

  if (addRes.ok || addRes.status === 409) {
    logger.info(`[RealmProvisioning] Set "${defaultRoleName}" as default role`);
  } else {
    logger.warn(`[RealmProvisioning] Failed to set default role (non-fatal): ${addRes.status}`);
  }
}

/**
 * Step 4: Create groups and assign role mappings.
 */
async function _createGroups(realmName: string) {
  for (const groupDef of GROUPS) {
    // Create the group
    const createRes = await adminFetch(realmName, '/groups', {
      method: 'POST',
      body: JSON.stringify({ name: groupDef.name }),
    });

    let groupId;

    if (createRes.status === 409) {
      // Group exists — find it
      const searchRes = await adminFetch(realmName, `/groups?search=${encodeURIComponent(groupDef.name)}&exact=true`);
      const groups = searchRes.ok ? await searchRes.json() : [];
      const match = groups.find((g: Record<string, unknown>) => g.name === groupDef.name);
      if (!match) {
        logger.warn(`[RealmProvisioning] Group "${groupDef.name}" conflict but could not find — skipping`);
        continue;
      }
      groupId = match.id;
    } else if (createRes.ok) {
      const location = createRes.headers.get('Location');
      groupId = location ? location.split('/').pop() : null;
      if (!groupId) {
        // Fallback: search
        const searchRes = await adminFetch(realmName, `/groups?search=${encodeURIComponent(groupDef.name)}&exact=true`);
        const groups = searchRes.ok ? await searchRes.json() : [];
        groupId = groups.find((g: Record<string, unknown>) => g.name === groupDef.name)?.id;
      }
    } else {
      const err = await createRes.text();
      logger.error(`[RealmProvisioning] Failed to create group "${groupDef.name}" (${createRes.status}): ${err}`);
      continue;
    }

    if (!groupId) {
      logger.warn(`[RealmProvisioning] Could not resolve group ID for "${groupDef.name}" — skipping role mapping`);
      continue;
    }

    // Map roles to the group
    if (groupDef.roles && groupDef.roles.length > 0) {
      const roleRepresentations = [];
      for (const roleName of groupDef.roles) {
        const roleRes = await adminFetch(realmName, `/roles/${encodeURIComponent(roleName)}`);
        if (roleRes.ok) {
          roleRepresentations.push(await roleRes.json());
        }
      }

      if (roleRepresentations.length > 0) {
        await adminFetch(realmName, `/groups/${groupId}/role-mappings/realm`, {
          method: 'POST',
          body: JSON.stringify(roleRepresentations),
        });
      }
    }
  }

  logger.info(`[RealmProvisioning] Created ${GROUPS.length} groups with role mappings`);
}

/**
 * Step 5: Create a confidential OIDC client for the platform backend.
 * Returns the generated client secret.
 */
async function _createConfidentialClient(realmName: string, clientId: string, agencyName: string) {
  const clientConfig = {
    clientId,
    name: `${agencyName} Platform`,
    description: 'Confidential OIDC client for the AccessHive platform backend',
    protocol: 'openid-connect',
    enabled: true,
    publicClient: false,
    serviceAccountsEnabled: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    fullScopeAllowed: true,
    redirectUris: [
      `${APP_BASE_URL}/api/auth/keycloak/callback`,
      `${APP_BASE_URL}/api/checkout/finish`,
    ],
    webOrigins: [APP_BASE_URL],
    attributes: {
      'pkce.code.challenge.method': 'S256',
    },
  };

  const res = await adminFetch(realmName, '/clients', {
    method: 'POST',
    body: JSON.stringify(clientConfig),
  });

  let uuid;
  if (res.status === 409) {
    // Client exists — find it
    const searchRes = await adminFetch(realmName, `/clients?clientId=${encodeURIComponent(clientId)}`);
    const clients = searchRes.ok ? await searchRes.json() : [];
    uuid = clients[0]?.id;
    if (!uuid) throw new Error(`Confidential client "${clientId}" conflict but could not find`);
  } else if (res.ok) {
    const location = res.headers.get('Location');
    uuid = location ? location.split('/').pop() : null;
    if (!uuid) {
      const searchRes = await adminFetch(realmName, `/clients?clientId=${encodeURIComponent(clientId)}`);
      const clients = searchRes.ok ? await searchRes.json() : [];
      uuid = clients[0]?.id;
    }
  } else {
    const err = await res.text();
    throw new Error(`Failed to create confidential client "${clientId}" (${res.status}): ${err}`);
  }

  // Fetch the generated client secret
  const secretRes = await adminFetch(realmName, `/clients/${uuid}/client-secret`);
  if (!secretRes.ok) {
    throw new Error(`Failed to fetch client secret for "${clientId}" (${secretRes.status})`);
  }
  const secretData = await secretRes.json();
  const clientSecret = secretData.value;

  if (!clientSecret) {
    throw new Error(`Client secret is empty for "${clientId}"`);
  }

  logger.info(`[RealmProvisioning] Created confidential OIDC client "${clientId}"`);
  return clientSecret;
}

/**
 * Step 6: Create a public PKCE client for the frontend SPA.
 */
async function _createPublicClient(realmName: string, clientId: string, agencyName: string) {
  const clientConfig = {
    clientId,
    name: `${agencyName} Frontend`,
    description: 'Public OIDC client (PKCE) for the AccessHive frontend SPA',
    protocol: 'openid-connect',
    enabled: true,
    publicClient: true,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    implicitFlowEnabled: false,
    fullScopeAllowed: true,
    redirectUris: [
      `${APP_BASE_URL}/api/auth/keycloak/callback`,
      `${APP_BASE_URL}/api/checkout/finish`,
    ],
    webOrigins: [APP_BASE_URL],
    attributes: {
      'pkce.code.challenge.method': 'S256',
    },
  };

  const res = await adminFetch(realmName, '/clients', {
    method: 'POST',
    body: JSON.stringify(clientConfig),
  });

  if (res.status === 409) {
    logger.info(`[RealmProvisioning] Public client "${clientId}" already exists`);
    return;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create public client "${clientId}" (${res.status}): ${err}`);
  }

  logger.info(`[RealmProvisioning] Created public PKCE client "${clientId}"`);
}

/**
 * Step 7: Create the pam-browser authentication flow.
 *
 * Flow structure:
 *   pam-browser (top-level flow)
 *   ├── Cookie (ALTERNATIVE) — SSO session re-authentication
 *   └── pam-browser-forms (ALTERNATIVE, sub-flow)
 *       ├── Username Password Form (REQUIRED)
 *       ├── OTP Form (OPTIONAL)
 *       └── PAM Chooser (REQUIRED) — custom SPI execution
 *
 * After creation, bind as the realm's browser flow.
 */
async function _createPamBrowserFlow(realmName: string) {
  const FLOW_ALIAS = 'pam-browser';

  // Check if flow already exists
  const existingRes = await adminFetch(realmName, '/authentication/flows');
  if (existingRes.ok) {
    const flows = await existingRes.json();
    if (flows.find((f: Record<string, unknown>) => f.alias === FLOW_ALIAS)) {
      logger.info(`[RealmProvisioning] Auth flow "${FLOW_ALIAS}" already exists — binding as browser flow`);
      await _bindBrowserFlow(realmName, FLOW_ALIAS);
      return;
    }
  }

  // Create top-level flow
  const createFlowRes = await adminFetch(realmName, '/authentication/flows', {
    method: 'POST',
    body: JSON.stringify({
      alias: FLOW_ALIAS,
      description: 'Browser flow with PAM Chooser for IdP-initiated SAML SSO',
      providerId: 'basic-flow',
      topLevel: true,
      builtIn: false,
    }),
  });

  if (!createFlowRes.ok && createFlowRes.status !== 409) {
    const err = await createFlowRes.text();
    throw new Error(`Failed to create auth flow "${FLOW_ALIAS}" (${createFlowRes.status}): ${err}`);
  }

  // Add Cookie execution (ALTERNATIVE)
  await _addExecution(realmName, FLOW_ALIAS, 'auth-cookie', 'ALTERNATIVE', FLOW_ALIAS);

  // Create sub-flow for forms (ALTERNATIVE)
  const subFlowAlias = `${FLOW_ALIAS}-forms`;
  await _createSubFlow(realmName, FLOW_ALIAS, subFlowAlias, 'Username/password + OTP + PAM Chooser');

  // Set the sub-flow execution to ALTERNATIVE
  await _setExecutionRequirement(realmName, FLOW_ALIAS, subFlowAlias, 'ALTERNATIVE');

  // Add Username Password Form to sub-flow (REQUIRED)
  await _addExecution(realmName, subFlowAlias, 'auth-username-password-form', 'REQUIRED', FLOW_ALIAS);

  // Create conditional OTP sub-flow (CONDITIONAL), nested under the forms sub-flow
  const otpSubFlowAlias = `${FLOW_ALIAS}-conditional-otp`;
  await _createSubFlow(realmName, subFlowAlias, otpSubFlowAlias, 'Conditional OTP — only if user has OTP configured');
  await _setExecutionRequirement(realmName, FLOW_ALIAS, otpSubFlowAlias, 'CONDITIONAL');

  // Add conditional-user-configured condition inside OTP sub-flow
  // IMPORTANT: topFlowAlias must be the top-level flow — Keycloak nests all executions there
  await _addExecution(realmName, otpSubFlowAlias, 'conditional-user-configured', 'REQUIRED', FLOW_ALIAS);
  // Add OTP form inside conditional sub-flow
  await _addExecution(realmName, otpSubFlowAlias, 'auth-otp-form', 'REQUIRED', FLOW_ALIAS);

  // Add PAM Chooser to sub-flow (REQUIRED)
  await _addExecution(realmName, subFlowAlias, 'pam-chooser-authenticator', 'REQUIRED', FLOW_ALIAS);

  // Bind as browser flow
  await _bindBrowserFlow(realmName, FLOW_ALIAS);

  logger.info(`[RealmProvisioning] Created and bound "${FLOW_ALIAS}" authentication flow`);
}

/**
 * Create a sub-flow (a new authentication flow nested inside a parent flow).
 *
 * Keycloak's Admin REST API exposes this as:
 *   POST /authentication/flows/{parentFlowAlias}/executions/flow
 * with body { alias, type, description, provider }. The previous code used
 * the non-existent `/authentication/flows/{alias}/flows` path and did not
 * check the response, so the sub-flow was silently never created and every
 * child execution then 400'd with "Parent flow doesn't exist".
 *
 * `provider` is required by the endpoint even for type "basic-flow" (where
 * it is otherwise unused) — "registration-page-form" mirrors what the admin
 * console sends. 409 is tolerated for idempotent re-runs.
 */
async function _createSubFlow(realmName: string, parentFlowAlias: string, subFlowAlias: string, description: string) {
  const res = await adminFetch(
    realmName,
    `/authentication/flows/${encodeURIComponent(parentFlowAlias)}/executions/flow`,
    {
      method: 'POST',
      body: JSON.stringify({
        alias: subFlowAlias,
        type: 'basic-flow',
        description,
        provider: 'registration-page-form',
      }),
    },
  );

  if (res.status === 409) {
    logger.info(`[RealmProvisioning] Sub-flow "${subFlowAlias}" already exists — continuing`);
    return;
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create sub-flow "${subFlowAlias}" under "${parentFlowAlias}" (${res.status}): ${err}`);
  }
}

/**
 * Add an execution to a flow and set its requirement.
 *
 * topFlowAlias: the top-level flow alias used to query/update executions.
 *   Keycloak requires querying from the top-level flow to see all nested executions.
 * targetFlowAlias: the sub-flow alias where the execution is actually added.
 *   When adding to the top-level flow, pass the same value for both.
 */
async function _addExecution(realmName: string, targetFlowAlias: string, providerId: string, requirement: string, topFlowAlias: string) {
  const addRes = await adminFetch(
    realmName,
    `/authentication/flows/${encodeURIComponent(targetFlowAlias)}/executions/execution`,
    {
      method: 'POST',
      body: JSON.stringify({ provider: providerId }),
    }
  );

  if (!addRes.ok && addRes.status !== 409) {
    const err = await addRes.text();
    logger.warn(`[RealmProvisioning] Failed to add execution "${providerId}" to flow "${targetFlowAlias}" (${addRes.status}): ${err}`);
    return;
  }

  // Find the execution we just added and set its requirement
  // Always query from the top-level flow to see nested executions
  await _setExecutionRequirement(realmName, topFlowAlias || targetFlowAlias, providerId, requirement);
}

/**
 * Set the requirement level on an execution within a flow.
 * Always pass the top-level flow alias — Keycloak nests all executions under it.
 */
async function _setExecutionRequirement(realmName: string, topFlowAlias: string, executionIdentifier: string, requirement: string) {
  // Fetch all executions for the top-level flow (includes nested)
  const execsRes = await adminFetch(realmName, `/authentication/flows/${encodeURIComponent(topFlowAlias)}/executions`);
  if (!execsRes.ok) return;

  const executions = await execsRes.json();

  // Find the execution by providerId or displayName (for sub-flows)
  const exec = executions.find(
    (e: Record<string, unknown>) => e.providerId === executionIdentifier || e.displayName === executionIdentifier || e.alias === executionIdentifier
  );

  if (!exec) {
    logger.warn(`[RealmProvisioning] Could not find execution "${executionIdentifier}" in flow "${topFlowAlias}"`);
    return;
  }

  // Update the requirement
  exec.requirement = requirement;
  await adminFetch(realmName, `/authentication/flows/${encodeURIComponent(topFlowAlias)}/executions`, {
    method: 'PUT',
    body: JSON.stringify(exec),
  });
}

/**
 * Bind a flow as the realm's browser authentication flow.
 */
async function _bindBrowserFlow(realmName: string, flowAlias: string) {
  // Get current realm config
  const realmRes = await adminFetch(realmName, '');
  if (!realmRes.ok) {
    logger.warn(`[RealmProvisioning] Failed to fetch realm config for flow binding`);
    return;
  }

  const realmConfig = await realmRes.json();
  realmConfig.browserFlow = flowAlias;

  const updateRes = await adminFetch(realmName, '', {
    method: 'PUT',
    body: JSON.stringify(realmConfig),
  });

  if (!updateRes.ok) {
    const err = await updateRes.text();
    logger.warn(`[RealmProvisioning] Failed to bind browser flow "${flowAlias}" (${updateRes.status}): ${err}`);
  }
}

// ─── Bull job wrapper ─────────────────────────────────────────────────────────

interface ProvisionRealmPayload {
  agencyId?: string;
  /** Some enqueue paths key tenant work as `tenantId`; for this system job the
   *  two are the same agency id. agencyId wins when both are present. */
  tenantId?: string;
  agencySlug?: string;
  agencyName?: string;
  triggeredBy?: string;
}

interface ProvisionRealmJobResult {
  status: 'completed';
  jobType: 'iam_provision_realm';
  realmName?: string;
  outcome?: 'provisioned' | 'skipped';
}

/**
 * SYSTEM-queue worker entrypoint for `iam_provision_realm`. Enqueued by the web
 * app during agency creation (see app/api/auth/create-agency). Delegates to
 * provisionAgencyRealm and throws on failure so Bull retries (attempts:5);
 * provisionAgencyRealm has already rolled back any partial realm and recorded
 * `keycloak_realm_status='error'` before we throw.
 */
export default async function iamProvisionRealm(
  job: { id?: unknown; data: ProvisionRealmPayload },
): Promise<ProvisionRealmJobResult> {
  const jobId = job.id;
  const agencyId = job.data.agencyId || job.data.tenantId;
  const { agencySlug, agencyName } = job.data;

  if (!agencyId) throw new Error('iam_provision_realm: missing required field agencyId');
  if (!agencySlug) throw new Error('iam_provision_realm: missing required field agencySlug');

  if (!isKeycloakAdminConfigured()) {
    logger.warn('iam_provision_realm: Keycloak admin not configured — skipping realm provision', { jobId, agencyId });
    return { status: 'completed', jobType: 'iam_provision_realm', outcome: 'skipped' };
  }

  const result = await provisionAgencyRealm(agencyId, agencySlug, agencyName || agencySlug);
  if (!result.success) {
    throw new Error(`iam_provision_realm: provisioning failed for ${agencyId}: ${result.error ?? 'unknown error'}`);
  }
  return { status: 'completed', jobType: 'iam_provision_realm', realmName: result.realmName, outcome: 'provisioned' };
}
