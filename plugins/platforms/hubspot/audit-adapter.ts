/**
 * HubSpot Audit Adapter
 *
 * Polls HubSpot audit/activity APIs for:
 * - Login activity (success/failures)
 * - User management events
 * - Settings changes
 *
 * Uses:
 * - /account-info/v3/activity/login — Login audit logs
 * - /account-info/v3/activity/audit-logs — General activity logs
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
}

interface AuditEvent {
  eventType: string;
  source: string;
  severity: string;
  actor: { id: string | null; email: string; type: string };
  agency: { id: string; slug: string };
  resource: { type: string; id: string | null; name: string | null };
  context: Record<string, unknown>;
}

interface AuditAdapterResult {
  events: AuditEvent[];
  cursor: Record<string, unknown>;
  errors: string[];
}

interface HubSpotLoginEntry {
  loginAt?: string;
  timestamp?: string;
  loginSucceeded?: boolean;
  userId?: string;
  id?: string;
  email?: string;
  ipAddress?: string;
  userAgent?: string;
  regionCode?: string;
}

interface HubSpotAuditEntry {
  timestamp?: string;
  createdAt?: string;
  action?: string;
  category?: string;
  userId?: string;
  actorId?: string;
  userEmail?: string;
  actorEmail?: string;
  objectType?: string;
  objectId?: string;
  objectName?: string;
  details?: Record<string, unknown>;
}

interface HubSpotPaginatedResponse<T> {
  results?: T[];
  paging?: { next?: { after?: string } };
}

const HUBSPOT_API = 'https://api.hubapi.com';
const MAX_PAGES = 5;

// ─── Event Type Mapping ──────────────────────────────────────────────────────

const ACTIVITY_TYPE_MAP: Record<string, string> = {
  'LOGIN_SUCCEEDED': 'platform.hubspot.user.login',
  'LOGIN_FAILED': 'platform.hubspot.user.login_failed',
  'USER_ADDED': 'platform.hubspot.user.added',
  'USER_REMOVED': 'platform.hubspot.user.removed',
  'USER_UPDATED': 'platform.hubspot.user.updated',
  'CONTACT_CREATED': 'platform.hubspot.contact.created',
  'CONTACT_UPDATED': 'platform.hubspot.contact.updated',
  'SETTING_CHANGED': 'platform.hubspot.setting.changed',
  'PERMISSION_CHANGED': 'platform.hubspot.setting.changed',
  'INTEGRATION_INSTALLED': 'platform.hubspot.integration.installed',
  'INTEGRATION_UNINSTALLED': 'platform.hubspot.integration.uninstalled',
};

function mapEventType(activityType: string): string {
  return ACTIVITY_TYPE_MAP[activityType] || `platform.hubspot.activity.${(activityType || 'unknown').toLowerCase()}`;
}

function severityForEvent(eventType: string): string {
  if (eventType.includes('login_failed')) return 'warning';
  if (eventType.includes('user.removed') || eventType.includes('user.added')) return 'warning';
  if (eventType.includes('setting.changed')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll HubSpot audit/activity events.
 *
 * @param accessToken - Valid OAuth access token with account-info.security.read scope
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  // ── Poll login activity ────────────────────────────────────────────────

  try {
    let afterCursor: string | null = (cursor.loginAfter as string) || null;
    let pageCount = 0;

    while (pageCount < MAX_PAGES) {
      pageCount++;

      let url = `${HUBSPOT_API}/account-info/v3/activity/login?limit=100`;
      if (afterCursor) url += `&after=${afterCursor}`;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status !== 403) {
          errors.push(`Login activity: ${res.status} ${errText}`);
        }
        break;
      }

      const data = await res.json() as HubSpotPaginatedResponse<HubSpotLoginEntry>;
      const results = data.results || [];

      for (const entry of results) {
        const entryTime = new Date(entry.loginAt || entry.timestamp || 0);
        if (entryTime <= since) continue;

        const isSuccess = entry.loginSucceeded !== false;
        const eventType = isSuccess ? 'platform.hubspot.user.login' : 'platform.hubspot.user.login_failed';

        events.push({
          eventType,
          source: 'hubspot',
          severity: severityForEvent(eventType),
          actor: {
            id: entry.userId || entry.id || null,
            email: entry.email || 'unknown',
            type: 'user',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: 'user',
            id: entry.userId || entry.id || null,
            name: entry.email || null,
          },
          context: {
            loginAt: entry.loginAt || entry.timestamp,
            ipAddress: entry.ipAddress,
            userAgent: entry.userAgent,
            regionCode: entry.regionCode,
            platformId: context.platformId,
          },
        });
      }

      // Pagination
      if (data.paging?.next?.after) {
        afterCursor = data.paging.next.after;
        cursor.loginAfter = afterCursor;
      } else {
        delete cursor.loginAfter;
        break;
      }
    }
  } catch (err) {
    errors.push(`Login activity: ${(err as Error).message}`);
  }

  // ── Poll audit logs (general activity) ─────────────────────────────────

  try {
    let afterCursor: string | null = (cursor.auditAfter as string) || null;
    let pageCount = 0;

    while (pageCount < MAX_PAGES) {
      pageCount++;

      let url = `${HUBSPOT_API}/account-info/v3/activity/audit-logs?limit=100`;
      if (afterCursor) url += `&after=${afterCursor}`;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        // Audit logs endpoint may not be available on all HubSpot tiers
        if (res.status === 403 || res.status === 404) {
          break; // Skip silently — not available
        }
        const errText = await res.text();
        errors.push(`Audit logs: ${res.status} ${errText}`);
        break;
      }

      const data = await res.json() as HubSpotPaginatedResponse<HubSpotAuditEntry>;
      const results = data.results || [];

      for (const entry of results) {
        const entryTime = new Date(entry.timestamp || entry.createdAt || 0);
        if (entryTime <= since) continue;

        const eventType = mapEventType(entry.action || entry.category || '');

        events.push({
          eventType,
          source: 'hubspot',
          severity: severityForEvent(eventType),
          actor: {
            id: entry.userId || entry.actorId || null,
            email: entry.userEmail || entry.actorEmail || 'system',
            type: entry.userId ? 'user' : 'system',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: entry.objectType || 'setting',
            id: entry.objectId || null,
            name: entry.objectName || null,
          },
          context: {
            action: entry.action,
            category: entry.category,
            timestamp: entry.timestamp,
            details: entry.details,
            platformId: context.platformId,
          },
        });
      }

      // Pagination
      if (data.paging?.next?.after) {
        afterCursor = data.paging.next.after;
        cursor.auditAfter = afterCursor;
      } else {
        delete cursor.auditAfter;
        break;
      }
    }
  } catch (err) {
    errors.push(`Audit logs: ${(err as Error).message}`);
  }

  return { events, cursor, errors };
}
