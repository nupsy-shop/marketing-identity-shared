/**
 * Google Workspace Audit Poll — Plugin Processor
 *
 * Processes gws_poll_audit Bull jobs. Polls Google Admin Reports API
 * for directory audit logs and sign-in logs, publishes events to
 * Elasticsearch.
 *
 * Only runs if auditIngestionEnabled is true on the identity source.
 *
 * Uses: https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/{app}
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent, flushAll } from '../../../../lib/audit/publisher.js';
import {
  computePollSince,
  loadSeenEventKeys,
  shouldPublishEvent,
  eventDedupKey,
} from '../../../../lib/audit/poll-window.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: string;
  eventsPublished?: number;
  reason?: string;
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in?: number;
}

interface ReportItem {
  id?: {
    time?: string;
    uniqueQualifier?: string;
    applicationName?: string;
    customerId?: string;
  };
  actor?: {
    email?: string;
    profileId?: string;
  };
  ipAddress?: string;
  events?: Array<{
    type?: string;
    name?: string;
    parameters?: Array<{ name?: string; value?: string; multiValue?: string[] }>;
  }>;
}

interface ReportsResponse {
  items?: ReportItem[];
  nextPageToken?: string;
}

// ─── Event Type Mapping ─────────────────────────────────────────────────────

const EVENT_MAP: Record<string, { type: string; severity: string }> = {
  'login.login_success': { type: 'platform.gws.user.login', severity: 'info' },
  'login.login_failure': { type: 'platform.gws.user.login_failed', severity: 'warning' },
  'admin.CREATE_USER': { type: 'platform.gws.user.created', severity: 'info' },
  'admin.DELETE_USER': { type: 'platform.gws.user.deleted', severity: 'warning' },
  'admin.SUSPEND_USER': { type: 'platform.gws.user.suspended', severity: 'warning' },
  'admin.UNSUSPEND_USER': { type: 'platform.gws.user.unsuspended', severity: 'info' },
  'admin.CHANGE_PASSWORD': { type: 'platform.gws.user.password_changed', severity: 'info' },
  'admin.ADD_GROUP_MEMBER': { type: 'platform.gws.group.member_added', severity: 'info' },
  'admin.REMOVE_GROUP_MEMBER': { type: 'platform.gws.group.member_removed', severity: 'info' },
  'admin.CREATE_GROUP': { type: 'platform.gws.group.created', severity: 'info' },
  'admin.DELETE_GROUP': { type: 'platform.gws.group.deleted', severity: 'warning' },
  'admin.GRANT_ADMIN_PRIVILEGE': { type: 'platform.gws.admin.role_assigned', severity: 'warning' },
  'admin.REVOKE_ADMIN_PRIVILEGE': { type: 'platform.gws.admin.role_removed', severity: 'warning' },
};

// ─── Processor ──────────────────────────────────────────────────────────────

export default async function gwsPollAudit(job: Bull.Job): Promise<JobResult> {
  const { tenantId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Get identity source
  const source = await prisma.identity_sources.findFirst({
    where: { agency_id: tenantId, plugin_key: 'google-workspace' },
    select: { id: true, connection_config: true, oauth_token_id: true },
  });

  if (!source) {
    logger.info('gws_poll_audit: no GWS source found, skipped', { jobId: String(job.id) });
    return {
      status: 'skipped',
      jobType: 'gws_poll_audit',
      eventsPublished: 0,
      reason: 'no Google Workspace source',
    };
  }

  const config = (source.connection_config || {}) as Record<string, unknown>;

  // 2. Check toggle (defensive — the dispatcher already filters by this)
  if (!config.auditIngestionEnabled) {
    logger.info('gws_poll_audit: audit ingestion disabled, skipped', { jobId: String(job.id) });
    return {
      status: 'skipped',
      jobType: 'gws_poll_audit',
      eventsPublished: 0,
      reason: 'audit ingestion disabled',
    };
  }

  // 3. Get OAuth token
  const oauthToken = await prisma.oauth_tokens.findFirst({
    where: { agency_id: tenantId, platformKey: 'google-workspace', isActive: true },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, accessToken: true, refreshToken: true, expiresAt: true },
  });

  if (!oauthToken) {
    // Audit is enabled but no active OAuth token — user must reconnect.
    // Throw so the job is marked failed and the error surfaces in the dashboard.
    throw new Error('Google Workspace OAuth token missing — reconnect the identity source');
  }

  let accessToken = oauthToken.accessToken;

  // 4. Refresh if expired
  if (oauthToken.expiresAt && new Date(oauthToken.expiresAt) < new Date()) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!oauthToken.refreshToken || !clientId || !clientSecret) {
      throw new Error(
        'Google Workspace token expired and cannot be refreshed — reconnect the identity source',
      );
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: oauthToken.refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`Google Workspace token refresh failed: HTTP ${res.status}`);
    }

    const tokenData: GoogleTokenResponse = await res.json();
    accessToken = tokenData.access_token;

    // Update token in DB
    await prisma.oauth_tokens.update({
      where: { id: oauthToken.id },
      data: {
        accessToken: tokenData.access_token,
        expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000),
        updatedAt: new Date(),
      },
    });
  }

  // 5. Determine poll window
  // Pre-run cursor — used to gate keyless events in the lookback overlap.
  const previousCursor =
    typeof config.lastAuditPollAt === 'string' ? config.lastAuditPollAt : null;
  const previousCursorMs = previousCursor ? new Date(previousCursor).getTime() : null;
  // Lookback overlap so events Google surfaces late aren't permanently skipped.
  const since = computePollSince(config.lastAuditPollAt as string | undefined);

  const agency = await prisma.agencies.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  const agencySlug = agency?.slug || '';

  // Events already ingested in [since, now] — so the lookback overlap re-fetches
  // but never re-publishes. Non-fatal: on failure we degrade to no-dedup (the
  // chain + mirror remain the source of truth) rather than crash the poll.
  const seen = await loadSeenEventKeys({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    prisma: prisma as any,
    agencyId: tenantId,
    since,
    eventTypePrefix: 'platform.gws.',
  }).catch((err: unknown) => {
    logger.warn('gws_poll_audit: dedup seen-set load failed (continuing without dedup)', {
      err: err instanceof Error ? err.message : String(err),
    });
    return new Set<string>();
  });

  // 6. Poll Google Admin Reports API
  let totalEvents = 0;
  const apps = ['login', 'admin'];

  for (const app of apps) {
    let pageToken: string | undefined;
    do {
      const url = new URL(`https://admin.googleapis.com/admin/reports/v1/activity/users/all/applications/${app}`);
      url.searchParams.set('startTime', since.toISOString());
      url.searchParams.set('maxResults', '200');
      if (pageToken) url.searchParams.set('pageToken', pageToken);

      const res = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!res.ok) {
        throw new Error(`Google Workspace Reports API (${app}) returned HTTP ${res.status}`);
      }

      const data: ReportsResponse = await res.json();
      const items = data.items || [];

      for (const item of items) {
        for (const event of item.events || []) {
          const mapKey = `${app}.${event.name}`;
          const mapped = EVENT_MAP[mapKey] || { type: `platform.gws.${app}.${event.name}`, severity: 'info' };

          // Dedup the lookback overlap (key = Google uniqueQualifier, persisted
          // as resource.id). Keyless events are gated on previousCursor instead.
          const key = eventDedupKey(item.id?.uniqueQualifier);
          const eventTimeMs = item.id?.time ? new Date(item.id.time).getTime() : null;
          if (!shouldPublishEvent({ key, eventTimeMs, seen, previousCursorMs })) {
            continue;
          }

          // NOTE: identity correlation (mirror.identityId) is resolved downstream
          // from actor.email against the CURRENT integration_identities. A late
          // event whose synthetic identity was offboarded between eventTime and
          // ingestion will not correlate — a documented limitation (#2312 spec).
          await publishAuditEvent({
            eventType: mapped.type,
            source: 'google-workspace',
            severity: mapped.severity,
            actor: {
              id: item.actor?.profileId || null,
              email: item.actor?.email || '',
              type: 'user',
              ip: item.ipAddress || null,
            },
            agency: { id: tenantId, slug: agencySlug },
            resource: {
              type: event.type || app,
              id: item.id?.uniqueQualifier || null,
              name: event.name || null,
            },
            context: {
              applicationName: item.id?.applicationName,
              parameters: event.parameters,
              platformId: source.id,
              // Real Google event time → mirror.occurredAt (deriveOccurredAt reads
              // context.eventTime). Without this, late-ingested events are stamped
              // at ingestion time and fall outside their true session window.
              eventTime: item.id?.time,
            },
            timestamp: item.id?.time ? new Date(item.id.time) : new Date(),
          });
          totalEvents++;
          if (key) seen.add(key);
        }
      }

      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  await flushAll();

  // 7. Update last poll timestamp
  await prisma.identity_sources.update({
    where: { id: source.id },
    data: {
      connection_config: {
        ...config,
        lastAuditPollAt: new Date().toISOString(),
      } as any,
      updated_at: new Date(),
    },
  });

  logger.info(`gws_poll_audit: published ${totalEvents} events`, {
    jobId: String(job.id), tenantId,
  });

  return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: totalEvents };
}
