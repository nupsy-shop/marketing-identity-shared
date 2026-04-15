/**
 * Entra ID Audit Poll — Plugin Processor
 *
 * Processes entra_poll_audit Bull jobs. Polls Microsoft Graph API
 * for directory audit logs and sign-in logs, publishes events to
 * Elasticsearch.
 *
 * Only runs if auditIngestionEnabled is true on the identity source.
 *
 * Uses:
 * - GET /auditLogs/directoryAudits
 * - GET /auditLogs/signIns
 *
 * Requires: AuditLog.Read.All application permission
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent, flushAll } from '../../../../lib/audit/publisher.js';

interface JobResult {
  status: 'completed';
  jobType: string;
  eventsPublished?: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
}

interface DirectoryAuditEntry {
  id?: string;
  activityDisplayName?: string;
  activityDateTime?: string;
  category?: string;
  result?: string;
  initiatedBy?: {
    user?: { id?: string; displayName?: string; userPrincipalName?: string; ipAddress?: string };
    app?: { appId?: string; displayName?: string };
  };
  targetResources?: Array<{
    id?: string;
    displayName?: string;
    type?: string;
    modifiedProperties?: Array<{ displayName?: string; oldValue?: string; newValue?: string }>;
  }>;
}

interface SignInEntry {
  id?: string;
  createdDateTime?: string;
  userDisplayName?: string;
  userPrincipalName?: string;
  userId?: string;
  ipAddress?: string;
  status?: { errorCode?: number; failureReason?: string };
  appDisplayName?: string;
  resourceDisplayName?: string;
  location?: { city?: string; state?: string; countryOrRegion?: string };
}

interface GraphListResponse<T> {
  value?: T[];
  '@odata.nextLink'?: string;
}

// ─── Event Type Mapping ─────────────────────────────────────────────────────

const ACTIVITY_MAP: Record<string, { type: string; severity: string }> = {
  'Add user': { type: 'platform.entra.user.created', severity: 'info' },
  'Delete user': { type: 'platform.entra.user.deleted', severity: 'warning' },
  'Update user': { type: 'platform.entra.user.updated', severity: 'info' },
  'Disable account': { type: 'platform.entra.user.suspended', severity: 'warning' },
  'Enable account': { type: 'platform.entra.user.unsuspended', severity: 'info' },
  'Reset user password': { type: 'platform.entra.user.password_changed', severity: 'info' },
  'Change user password': { type: 'platform.entra.user.password_changed', severity: 'info' },
  'Add member to group': { type: 'platform.entra.group.member_added', severity: 'info' },
  'Remove member from group': { type: 'platform.entra.group.member_removed', severity: 'info' },
  'Add group': { type: 'platform.entra.group.created', severity: 'info' },
  'Delete group': { type: 'platform.entra.group.deleted', severity: 'warning' },
  'Add member to role': { type: 'platform.entra.admin.role_assigned', severity: 'warning' },
  'Remove member from role': { type: 'platform.entra.admin.role_removed', severity: 'warning' },
  'Update policy': { type: 'platform.entra.admin.policy_updated', severity: 'info' },
  'Consent to application': { type: 'platform.entra.app.consent_granted', severity: 'info' },
};

// ─── Processor ──────────────────────────────────────────────────────────────

export default async function entraPollAudit(job: Bull.Job): Promise<JobResult> {
  const { tenantId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Get identity source
  const source = await prisma.identity_sources.findFirst({
    where: { agency_id: tenantId, plugin_key: 'entra-id' },
    select: { id: true, connection_config: true },
  });

  if (!source) {
    logger.info('entra_poll_audit: no Entra ID source found, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_poll_audit', eventsPublished: 0 };
  }

  const config = (source.connection_config || {}) as Record<string, unknown>;

  // 2. Check toggle
  if (!config.auditIngestionEnabled) {
    logger.info('entra_poll_audit: audit ingestion disabled, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_poll_audit', eventsPublished: 0 };
  }

  // 3. Get access token via client credentials
  const msftTenantId = config.tenantId as string | undefined;
  const clientId = (config.clientId as string) || process.env.ENTRA_ID_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = (config.clientSecret as string) || process.env.ENTRA_ID_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET;

  if (!msftTenantId || !clientId || !clientSecret) {
    logger.warn('entra_poll_audit: missing credentials', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'entra_poll_audit', eventsPublished: 0 };
  }

  const tokenRes = await fetch(`https://login.microsoftonline.com/${msftTenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });

  if (!tokenRes.ok) {
    logger.error('entra_poll_audit: failed to obtain token', { jobId: String(job.id), status: tokenRes.status });
    return { status: 'completed', jobType: 'entra_poll_audit', eventsPublished: 0 };
  }

  const { access_token: accessToken }: TokenResponse = await tokenRes.json();

  // 4. Determine poll window
  const since = config.lastAuditPollAt
    ? new Date(config.lastAuditPollAt as string)
    : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const agency = await prisma.agencies.findUnique({
    where: { id: tenantId },
    select: { slug: true },
  });
  const agencySlug = agency?.slug || '';

  let totalEvents = 0;

  // 5. Poll directory audit logs
  const sinceFilter = since.toISOString();
  let nextLink: string | null = `https://graph.microsoft.com/v1.0/auditLogs/directoryAudits?$filter=activityDateTime ge ${sinceFilter}&$top=200&$orderby=activityDateTime asc`;

  while (nextLink) {
    const res = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      logger.warn(`entra_poll_audit: directoryAudits returned ${res.status}`, { jobId: String(job.id) });
      break;
    }

    const data: GraphListResponse<DirectoryAuditEntry> = await res.json();
    const entries = data.value || [];

    for (const entry of entries) {
      const mapped = ACTIVITY_MAP[entry.activityDisplayName || ''] || {
        type: `platform.entra.directory.${(entry.activityDisplayName || 'unknown').toLowerCase().replace(/\s+/g, '_')}`,
        severity: 'info',
      };

      const initiator = entry.initiatedBy?.user || entry.initiatedBy?.app;
      const target = entry.targetResources?.[0];

      await publishAuditEvent({
        eventType: mapped.type,
        source: 'entra-id',
        severity: entry.result === 'failure' ? 'warning' : mapped.severity,
        actor: {
          id: (initiator as any)?.id || (initiator as any)?.appId || null,
          email: (initiator as any)?.userPrincipalName || (initiator as any)?.displayName || '',
          type: entry.initiatedBy?.user ? 'user' : 'app',
          ip: (initiator as any)?.ipAddress || null,
        },
        agency: { id: tenantId, slug: agencySlug },
        resource: {
          type: target?.type || entry.category || 'directory',
          id: target?.id || null,
          name: target?.displayName || null,
        },
        context: {
          activityDisplayName: entry.activityDisplayName,
          category: entry.category,
          result: entry.result,
          modifiedProperties: target?.modifiedProperties,
          platformId: source.id,
        },
        timestamp: entry.activityDateTime ? new Date(entry.activityDateTime) : new Date(),
      });
      totalEvents++;
    }

    nextLink = data['@odata.nextLink'] || null;
  }

  // 6. Poll sign-in logs
  nextLink = `https://graph.microsoft.com/v1.0/auditLogs/signIns?$filter=createdDateTime ge ${sinceFilter}&$top=200&$orderby=createdDateTime asc`;

  while (nextLink) {
    const res = await fetch(nextLink, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      // Sign-in logs require Azure AD Premium — 403 is expected for free tier
      if (res.status === 403) {
        logger.info('entra_poll_audit: sign-in logs not available (requires Azure AD Premium)', { jobId: String(job.id) });
      } else {
        logger.warn(`entra_poll_audit: signIns returned ${res.status}`, { jobId: String(job.id) });
      }
      break;
    }

    const data: GraphListResponse<SignInEntry> = await res.json();
    const entries = data.value || [];

    for (const entry of entries) {
      const isFailure = (entry.status?.errorCode || 0) !== 0;

      await publishAuditEvent({
        eventType: isFailure ? 'platform.entra.user.login_failed' : 'platform.entra.user.login',
        source: 'entra-id',
        severity: isFailure ? 'warning' : 'info',
        actor: {
          id: entry.userId || null,
          email: entry.userPrincipalName || '',
          type: 'user',
          ip: entry.ipAddress || null,
        },
        agency: { id: tenantId, slug: agencySlug },
        resource: {
          type: 'application',
          id: null,
          name: entry.appDisplayName || null,
        },
        context: {
          errorCode: entry.status?.errorCode,
          failureReason: entry.status?.failureReason,
          location: entry.location,
          resourceDisplayName: entry.resourceDisplayName,
          platformId: source.id,
        },
        timestamp: entry.createdDateTime ? new Date(entry.createdDateTime) : new Date(),
      });
      totalEvents++;
    }

    nextLink = data['@odata.nextLink'] || null;
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

  logger.info(`entra_poll_audit: published ${totalEvents} events`, {
    jobId: String(job.id), tenantId,
  });

  return { status: 'completed', jobType: 'entra_poll_audit', eventsPublished: totalEvents };
}
