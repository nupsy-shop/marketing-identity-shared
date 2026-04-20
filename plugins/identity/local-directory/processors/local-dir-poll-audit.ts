/**
 * Local Directory Audit Poll — Plugin Processor
 *
 * Processes `local_dir_poll_audit` Bull jobs. Polls the internal
 * Keycloak admin API for admin-events + login-events scoped to the
 * agency's realm, publishes them to the audit pipeline, and advances
 * the per-agency cursor stored in `identity_sources.connection_config`.
 *
 * Lives inside the plugin directory per the user invariant: every
 * identity-source job ships alongside its plugin. The canonical
 * directory for plugin jobs in this codebase is `processors/` — the
 * spec's reference to `workers/` is treated as a semantic label, not
 * a filesystem path, to stay consistent with entra-id + gws.
 *
 * Auth: no OAuth tokens — uses the internal Keycloak admin client
 * via env vars (KC_ADMIN_URL, KC_ADMIN_CLIENT_ID, KC_ADMIN_CLIENT_SECRET,
 * KC_ADMIN_REALM). Local Directory is always connected per agency, so
 * there is nothing to "re-authorize" — if Keycloak is unreachable the
 * job fails loud and surfaces in the dashboard.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent, flushAll } from '../../../../lib/audit/publisher.js';

interface JobResult {
  status: 'completed' | 'skipped' | 'failed';
  jobType: string;
  eventsPublished?: number;
  reason?: string;
}

interface KeycloakAdminEvent {
  time?: number;
  realmId?: string;
  authDetails?: { realmId?: string; clientId?: string; userId?: string; ipAddress?: string };
  operationType?: string;
  resourceType?: string;
  resourcePath?: string;
  error?: string;
}

interface KeycloakLoginEvent {
  time?: number;
  type?: string;
  realmId?: string;
  clientId?: string;
  userId?: string;
  ipAddress?: string;
  error?: string;
  details?: Record<string, string | undefined>;
}

interface KeycloakTokenResponse {
  access_token: string;
  expires_in?: number;
}

async function getKeycloakAdminToken(): Promise<string> {
  const url = process.env.KC_ADMIN_URL;
  const clientId = process.env.KC_ADMIN_CLIENT_ID;
  const clientSecret = process.env.KC_ADMIN_CLIENT_SECRET;
  const realm = process.env.KC_ADMIN_REALM || 'master';

  if (!url || !clientId || !clientSecret) {
    throw new Error(
      'Keycloak admin client not configured — set KC_ADMIN_URL, KC_ADMIN_CLIENT_ID, KC_ADMIN_CLIENT_SECRET',
    );
  }

  const res = await fetch(`${url.replace(/\/$/, '')}/realms/${realm}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error(`Keycloak admin token request failed: HTTP ${res.status}`);
  }

  const data = (await res.json()) as KeycloakTokenResponse;
  return data.access_token;
}

export default async function localDirPollAudit(job: Bull.Job): Promise<JobResult> {
  const { tenantId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Resolve the identity source for this agency.
  const source = await prisma.identity_sources.findFirst({
    where: { agency_id: tenantId, plugin_key: 'local-directory' },
    select: { id: true, connection_config: true },
  });

  if (!source) {
    // Local Directory row missing is a bug — the back-fill migration + agency
    // creation hook must guarantee it exists. Surface as skipped so the job
    // completes and a follow-up dispatcher can enqueue again next tick.
    logger.warn('local_dir_poll_audit: no local-directory source row for agency', {
      jobId: String(job.id),
      tenantId,
    });
    return {
      status: 'skipped',
      jobType: 'local_dir_poll_audit',
      eventsPublished: 0,
      reason: 'local-directory source row missing',
    };
  }

  const config = (source.connection_config || {}) as Record<string, unknown>;

  // 2. Resolve the agency's Keycloak realm.
  const agency = await prisma.agencies.findUnique({
    where: { id: tenantId },
    select: { slug: true, keycloak_realm: true },
  });

  const realm = (agency as { keycloak_realm?: string | null } | null)?.keycloak_realm || agency?.slug;
  if (!realm) {
    throw new Error('Agency has no keycloak_realm — cannot poll local-directory audit events');
  }

  // 3. Determine poll window from cursor.
  const since = config.lastAuditPollAt
    ? new Date(config.lastAuditPollAt as string)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  // 4. Fetch admin events + login events from Keycloak.
  const token = await getKeycloakAdminToken();
  const base = (process.env.KC_ADMIN_URL || '').replace(/\/$/, '');

  const adminUrl = `${base}/admin/realms/${encodeURIComponent(realm)}/admin-events?dateFrom=${since.toISOString().slice(0, 10)}&max=200`;
  const loginUrl = `${base}/admin/realms/${encodeURIComponent(realm)}/events?dateFrom=${since.toISOString().slice(0, 10)}&max=200`;

  const [adminRes, loginRes] = await Promise.all([
    fetch(adminUrl, { headers: { Authorization: `Bearer ${token}` } }),
    fetch(loginUrl, { headers: { Authorization: `Bearer ${token}` } }),
  ]);

  if (!adminRes.ok) throw new Error(`Keycloak admin-events API returned HTTP ${adminRes.status}`);
  if (!loginRes.ok) throw new Error(`Keycloak login-events API returned HTTP ${loginRes.status}`);

  const adminEvents = (await adminRes.json()) as KeycloakAdminEvent[];
  const loginEvents = (await loginRes.json()) as KeycloakLoginEvent[];

  const agencyCtx = { id: tenantId, slug: agency?.slug || '' };
  let published = 0;

  for (const e of adminEvents) {
    const ts = e.time ? new Date(e.time) : new Date();
    if (ts <= since) continue;

    await publishAuditEvent({
      eventType: `platform.local-directory.admin.${(e.operationType || 'event').toLowerCase()}`,
      source: 'local-directory',
      severity: e.error ? 'warning' : 'info',
      actor: {
        id: e.authDetails?.userId || null,
        email: '',
        type: 'user',
        ip: e.authDetails?.ipAddress || null,
      },
      agency: agencyCtx,
      resource: {
        type: e.resourceType || 'unknown',
        id: e.resourcePath || null,
        name: e.operationType || null,
      },
      context: {
        realmId: e.realmId,
        error: e.error,
        platformId: source.id,
      },
      timestamp: ts,
    });
    published++;
  }

  for (const e of loginEvents) {
    const ts = e.time ? new Date(e.time) : new Date();
    if (ts <= since) continue;

    await publishAuditEvent({
      eventType: `platform.local-directory.user.${(e.type || 'event').toLowerCase()}`,
      source: 'local-directory',
      severity: e.error ? 'warning' : 'info',
      actor: {
        id: e.userId || null,
        email: e.details?.username || '',
        type: 'user',
        ip: e.ipAddress || null,
      },
      agency: agencyCtx,
      resource: {
        type: 'login',
        id: e.clientId || null,
        name: e.type || null,
      },
      context: {
        realmId: e.realmId,
        error: e.error,
        details: e.details,
        platformId: source.id,
      },
      timestamp: ts,
    });
    published++;
  }

  await flushAll();

  // 5. Advance the cursor.
  await prisma.identity_sources.update({
    where: { id: source.id },
    data: {
      connection_config: {
        ...config,
        lastAuditPollAt: new Date().toISOString(),
      },
      updated_at: new Date(),
    },
  });

  logger.info(`local_dir_poll_audit: published ${published} events`, {
    jobId: String(job.id),
    tenantId,
  });

  return {
    status: 'completed',
    jobType: 'local_dir_poll_audit',
    eventsPublished: published,
  };
}
