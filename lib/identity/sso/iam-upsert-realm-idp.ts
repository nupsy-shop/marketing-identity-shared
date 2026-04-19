/**
 * IAM Upsert Realm IdP — reconciles a per-agency Keycloak realm's
 * Identity Provider entries against `agency_settings` (issue #23).
 *
 * Contract
 * --------
 * Payload:
 *   agencyId         — tenant id whose realm is being reconciled
 *   desiredProvider  — 'okta' | 'azure_ad' | 'google' | 'oidc' | 'none'
 *                      (if missing, read from agency_settings.sso_provider)
 *   triggeredBy      — actor id / email / 'system'
 *
 * Invariants
 * ----------
 * - Idempotent: re-running converges on the same realm state.
 * - Discovers upstream endpoints from
 *     `{issuerUrl}/.well-known/openid-configuration`
 *   and never persists those URLs to agency_settings.
 * - On success: agency_settings.sso_config_status = 'synced', sso_last_error = null.
 * - On failure: agency_settings.sso_config_status = 'error',
 *   sso_last_error = '<code>: <message>' (secrets scrubbed).
 * - Secrets (client secret, discovery response body) never land in logs.
 * - Queue: SYSTEM (no tenantId in job_runs — see shared/lib/jobs/catalog.ts).
 *
 * Routing
 * -------
 * Registered on the worker in the SYSTEM queue alongside iam_provision_realm.
 * This module is framework-agnostic; it reads runtime services from
 * shared/lib/runtime.ts so the web app and worker can both dispatch it.
 */

import { getRuntime } from '../../runtime.js';
import {
  listRealmIdentityProviders,
  getRealmIdentityProvider,
  createRealmIdentityProvider,
  updateRealmIdentityProvider,
  deleteRealmIdentityProvider,
  listIdentityProviderMappers,
  createIdentityProviderMapper,
  isKeycloakAdminConfigured,
  type RealmIdentityProvider,
  type IdentityProviderMapper,
} from '../../keycloakAdmin.js';

export type DesiredProvider = 'okta' | 'azure_ad' | 'google' | 'oidc' | 'none';

export interface UpsertRealmIdpPayload {
  agencyId: string;
  desiredProvider?: DesiredProvider;
  triggeredBy?: string;
}

interface JobResult {
  status: 'completed';
  jobType: 'iam_upsert_realm_idp';
  outcome: 'synced' | 'no_change' | 'removed' | 'skipped';
}

// Fixed alias per provider so switching removes the old one and adds the new.
function aliasForProvider(provider: DesiredProvider): string {
  switch (provider) {
    case 'okta':     return 'okta';
    case 'azure_ad': return 'azure-ad';
    case 'google':   return 'google';
    case 'oidc':     return 'oidc';
    default:
      throw new Error(`aliasForProvider: unsupported provider ${provider}`);
  }
}

function displayNameFor(provider: DesiredProvider): string {
  switch (provider) {
    case 'okta':     return 'Sign in with Okta';
    case 'azure_ad': return 'Sign in with Microsoft';
    case 'google':   return 'Sign in with Google';
    case 'oidc':     return 'Sign in with SSO';
    default:         return 'Sign in with SSO';
  }
}

// Providers all broker via generic OIDC on Keycloak (providerId='oidc').
// Google has a first-class provider ('google') but we stick to 'oidc' for
// uniform claim mapping + discovery.
function providerIdFor(provider: DesiredProvider): string {
  return 'oidc';
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  end_session_endpoint?: string;
}

async function discoverIssuer(issuerUrl: string): Promise<Discovery> {
  const normalized = issuerUrl.replace(/\/+$/, '');
  const url = `${normalized}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`discovery_failed: network error fetching ${url}: ${msg}`);
  }
  if (!res.ok) {
    throw new Error(`discovery_failed: ${url} returned HTTP ${res.status}`);
  }
  let body: any;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`discovery_failed: malformed JSON from ${url}`);
  }
  const required = ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const;
  for (const k of required) {
    if (!body[k] || typeof body[k] !== 'string') {
      throw new Error(`discovery_failed: missing ${k} in discovery payload`);
    }
  }
  return {
    issuer: body.issuer,
    authorization_endpoint: body.authorization_endpoint,
    token_endpoint: body.token_endpoint,
    jwks_uri: body.jwks_uri,
    userinfo_endpoint: body.userinfo_endpoint,
    end_session_endpoint: body.end_session_endpoint,
  };
}

function buildIdpConfig(params: {
  clientId: string;
  clientSecret: string;
  discovery: Discovery;
  issuerUrl: string;
}): Record<string, string> {
  return {
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    issuer: params.issuerUrl,
    authorizationUrl: params.discovery.authorization_endpoint,
    tokenUrl: params.discovery.token_endpoint,
    jwksUrl: params.discovery.jwks_uri,
    useJwksUrl: 'true',
    userInfoUrl: params.discovery.userinfo_endpoint || '',
    logoutUrl: params.discovery.end_session_endpoint || '',
    validateSignature: 'true',
    syncMode: 'FORCE',
    defaultScope: 'openid profile email',
    clientAuthMethod: 'client_secret_basic',
    backchannelSupported: 'false',
    disableUserInfo: 'false',
  };
}

async function upsertEmailMapper(realm: string, alias: string): Promise<void> {
  const existing = await listIdentityProviderMappers(realm, alias).catch(() => []);
  const name = 'email-to-email';
  if (existing.some((m: IdentityProviderMapper) => m.name === name)) return;
  const mapper: IdentityProviderMapper = {
    name,
    identityProviderAlias: alias,
    identityProviderMapper: 'oidc-user-attribute-idp-mapper',
    config: {
      syncMode: 'INHERIT',
      claim: 'email',
      'user.attribute': 'email',
    },
  };
  await createIdentityProviderMapper(realm, alias, mapper);
}

function scrubError(raw: unknown, fallbackCode = 'reconcile_failed'): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? 'unknown error');
  // Redact anything that looks like a bearer token or secret value.
  const redacted = msg
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
    .replace(/"?client_secret"?\s*[:=]\s*"[^"]*"/gi, 'client_secret=[redacted]');
  if (/^\w+:/.test(redacted)) return redacted; // already prefixed (e.g. 'discovery_failed:')
  return `${fallbackCode}: ${redacted}`;
}

export default async function iamUpsertRealmIdp(job: { id?: unknown; data: UpsertRealmIdpPayload }): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const jobId = job.id;
  const { agencyId } = job.data;
  if (!agencyId) throw new Error('Missing required field: agencyId');

  // ─── Load desired state from DB (server-state, not payload) ──────────
  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
  });
  if (!settings) {
    throw new Error(`agency_settings not found for agency ${agencyId}`);
  }

  const realm: string | null = (settings as any).keycloak_realm;
  if (!realm) {
    // Cannot reconcile a realm that doesn't exist yet.
    await prisma.agency_settings.update({
      where: { agency_id: agencyId },
      data: {
        sso_config_status: 'error',
        sso_last_error: 'reconcile_failed: realm_not_provisioned',
        sso_config_updated_at: new Date(),
      },
    });
    throw new Error('reconcile_failed: realm_not_provisioned');
  }

  if (!isKeycloakAdminConfigured()) {
    logger.warn('Keycloak admin not configured — marking synced as a no-op', { jobId, agencyId });
    await prisma.agency_settings.update({
      where: { agency_id: agencyId },
      data: {
        sso_config_status: 'synced',
        sso_last_error: null,
        sso_config_updated_at: new Date(),
      },
    });
    return { status: 'completed', jobType: 'iam_upsert_realm_idp', outcome: 'skipped' };
  }

  const desired: DesiredProvider = (job.data.desiredProvider as DesiredProvider) ||
    ((settings as any).sso_provider as DesiredProvider | null) ||
    'none';

  try {
    if (desired === 'none' || !desired) {
      // Remove ALL IdPs — realm falls back to local credentials only.
      const existing = await listRealmIdentityProviders(realm);
      for (const idp of existing) {
        await deleteRealmIdentityProvider(realm, idp.alias);
      }
      await prisma.agency_settings.update({
        where: { agency_id: agencyId },
        data: {
          sso_config_status: 'synced',
          sso_last_error: null,
          sso_config_updated_at: new Date(),
        },
      });
      logger.info('Realm IdPs reconciled to none', { jobId, agencyId, realm });
      return { status: 'completed', jobType: 'iam_upsert_realm_idp', outcome: 'removed' };
    }

    const clientId: string | null = (settings as any).sso_client_id;
    const clientSecret: string | null = (settings as any).sso_client_secret;
    const issuerUrl: string | null = (settings as any).sso_issuer_url;

    if (!clientId || !clientSecret || !issuerUrl) {
      throw new Error('reconcile_failed: missing sso_client_id, sso_client_secret, or sso_issuer_url');
    }

    const discovery = await discoverIssuer(issuerUrl);
    const targetAlias = aliasForProvider(desired);
    const idpConfig = buildIdpConfig({ clientId, clientSecret, discovery, issuerUrl });

    const desiredIdp: RealmIdentityProvider = {
      alias: targetAlias,
      providerId: providerIdFor(desired),
      displayName: displayNameFor(desired),
      enabled: true,
      config: idpConfig,
    };

    // Remove any other (previous) IdPs — we enforce exactly one.
    const existing = await listRealmIdentityProviders(realm);
    for (const idp of existing) {
      if (idp.alias !== targetAlias) {
        await deleteRealmIdentityProvider(realm, idp.alias);
      }
    }

    // Upsert the target IdP.
    const current = await getRealmIdentityProvider(realm, targetAlias);
    if (current) {
      await updateRealmIdentityProvider(realm, targetAlias, desiredIdp);
    } else {
      await createRealmIdentityProvider(realm, desiredIdp);
    }

    // Ensure at minimum an email → email claim mapper.
    await upsertEmailMapper(realm, targetAlias);

    await prisma.agency_settings.update({
      where: { agency_id: agencyId },
      data: {
        sso_config_status: 'synced',
        sso_last_error: null,
        sso_config_updated_at: new Date(),
      },
    });
    logger.info('Realm IdP reconciled', { jobId, agencyId, realm, provider: desired, alias: targetAlias });
    return { status: 'completed', jobType: 'iam_upsert_realm_idp', outcome: 'synced' };
  } catch (err) {
    const scrubbed = scrubError(err);
    await prisma.agency_settings.update({
      where: { agency_id: agencyId },
      data: {
        sso_config_status: 'error',
        sso_last_error: scrubbed,
        sso_config_updated_at: new Date(),
      },
    }).catch(() => { /* best-effort status write */ });
    logger.error('iam_upsert_realm_idp failed', { jobId, agencyId, realm, error: scrubbed });
    throw err;
  }
}
