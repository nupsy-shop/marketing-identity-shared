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

interface JobResult {
  status: 'completed';
  jobType: string;
  eventsPublished?: number;
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
    return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: 0 };
  }

  const config = (source.connection_config || {}) as Record<string, unknown>;

  // 2. Check toggle
  if (!config.auditIngestionEnabled) {
    logger.info('gws_poll_audit: audit ingestion disabled, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: 0 };
  }

  // 3. Get OAuth token
  const oauthToken = await prisma.oauth_tokens.findFirst({
    where: { agency_id: tenantId, platformKey: 'google-workspace', isActive: true },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, accessToken: true, refreshToken: true, expiresAt: true },
  });

  if (!oauthToken) {
    logger.warn('gws_poll_audit: no active OAuth token', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: 0 };
  }

  let accessToken = oauthToken.accessToken;

  // 4. Refresh if expired
  if (oauthToken.expiresAt && new Date(oauthToken.expiresAt) < new Date()) {
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!oauthToken.refreshToken || !clientId || !clientSecret) {
      logger.warn('gws_poll_audit: token expired, cannot refresh', { jobId: String(job.id) });
      return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: 0 };
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
      logger.error('gws_poll_audit: token refresh failed', { jobId: String(job.id) });
      return { status: 'completed', jobType: 'gws_poll_audit', eventsPublished: 0 };
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
  const since = config.lastAuditPollAt
    ? new Date(config.lastAuditPollAt as string)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const agency = await prisma.agencies.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  const agencySlug = agency?.slug || '';

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
        logger.warn(`gws_poll_audit: Reports API ${app} returned ${res.status}`, { jobId: String(job.id) });
        break;
      }

      const data: ReportsResponse = await res.json();
      const items = data.items || [];

      for (const item of items) {
        for (const event of item.events || []) {
          const mapKey = `${app}.${event.name}`;
          const mapped = EVENT_MAP[mapKey] || { type: `platform.gws.${app}.${event.name}`, severity: 'info' };

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
            },
            timestamp: item.id?.time ? new Date(item.id.time) : new Date(),
          });
          totalEvents++;
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
