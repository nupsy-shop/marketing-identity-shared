/**
 * JumpCloud Audit Adapter
 *
 * Polls JumpCloud Directory Insights Events API for:
 * - User authentication events
 * - User lifecycle (create/delete/update)
 * - Group membership changes
 * - Admin activity
 *
 * Uses: https://api.jumpcloud.com/insights/directory/v1/events
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
  orgId?: string;
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

interface JcEvent {
  id?: string;
  event_type?: string;
  service?: string;
  success?: boolean;
  timestamp?: string;
  client_ip?: string;
  src_ip?: string;
  geoip?: Record<string, unknown>;
  organization?: string;
  initiated_by?: { id?: string; email?: string; type?: string };
  actor?: { id?: string; email?: string };
  resource?: { type?: string; id?: string; name?: string };
  system?: { id?: string; hostname?: string };
}

const JUMPCLOUD_API = 'https://api.jumpcloud.com';
const MAX_PAGES = 5;

// ─── Event Type Mapping ──────────────────────────────────────────────────────

const EVENT_MAP: Record<string, string> = {
  // Authentication
  'user_login_attempt': 'platform.jumpcloud.user.login',
  'sso_auth': 'platform.jumpcloud.user.login',
  'admin_login_attempt': 'platform.jumpcloud.admin.login',
  'user_auth': 'platform.jumpcloud.user.login',
  'radius_auth_attempt': 'platform.jumpcloud.user.login',
  'ldap_bind': 'platform.jumpcloud.user.login',

  // User lifecycle
  'user_create': 'platform.jumpcloud.user.created',
  'user_delete': 'platform.jumpcloud.user.deleted',
  'user_update': 'platform.jumpcloud.user.updated',
  'user_activated': 'platform.jumpcloud.user.created',
  'user_locked': 'platform.jumpcloud.user.locked',
  'user_unlocked': 'platform.jumpcloud.user.updated',
  'user_password_change': 'platform.jumpcloud.user.password_changed',
  'user_password_reset': 'platform.jumpcloud.user.password_changed',

  // Group membership
  'group_member_add': 'platform.jumpcloud.group.member_added',
  'group_member_remove': 'platform.jumpcloud.group.member_removed',
  'user_group_add': 'platform.jumpcloud.group.member_added',
  'user_group_remove': 'platform.jumpcloud.group.member_removed',
};

function mapEventType(jcEventType: string): string {
  return EVENT_MAP[jcEventType] || `platform.jumpcloud.event.${(jcEventType || 'unknown').replace(/\./g, '_')}`;
}

function severityForEvent(eventType: string, success: boolean): string {
  if (eventType.includes('login_failed') || success === false) return 'warning';
  if (eventType.includes('deleted') || eventType.includes('locked')) return 'warning';
  if (eventType.includes('password_changed')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll JumpCloud audit events.
 *
 * @param accessToken - JumpCloud API key
 * @param since - Only return events after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor, orgId }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  const headers: Record<string, string> = {
    'x-api-key': accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (context.orgId) {
    headers['x-org-id'] = context.orgId;
  }

  const sinceISO = since.toISOString();
  let searchAfter: { id: string } | null = (cursor.searchAfter as { id: string } | null) || null;
  let pageCount = 0;

  try {
    while (pageCount < MAX_PAGES) {
      pageCount++;

      const body: Record<string, unknown> = {
        service: ['directory', 'sso', 'radius', 'ldap', 'all'],
        start_time: sinceISO,
        limit: 100,
        sort: 'ASC',
      };

      if (searchAfter) {
        body.search_after = searchAfter;
      }

      const res = await fetch(`${JUMPCLOUD_API}/insights/directory/v1/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status !== 403) {
          errors.push(`JumpCloud events: ${res.status} ${errText}`);
        }
        break;
      }

      const jcEvents = await res.json() as JcEvent[];

      if (!Array.isArray(jcEvents) || jcEvents.length === 0) {
        break;
      }

      for (const jcEvent of jcEvents) {
        const success = jcEvent.success !== false;
        let rawEventType = jcEvent.event_type || jcEvent.service || 'unknown';

        // Determine if login failed
        if (rawEventType.includes('login') && !success) {
          rawEventType = rawEventType.replace('login', 'login_failed');
        }

        const eventType = mapEventType(rawEventType);

        events.push({
          eventType: !success && eventType.includes('.login') ? eventType.replace('.login', '.login_failed') : eventType,
          source: 'jumpcloud',
          severity: severityForEvent(eventType, success),
          actor: {
            id: jcEvent.initiated_by?.id || jcEvent.actor?.id || null,
            email: jcEvent.initiated_by?.email || jcEvent.actor?.email || 'system',
            type: jcEvent.initiated_by?.type === 'admin' ? 'admin' : 'user',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: jcEvent.resource?.type || 'user',
            id: jcEvent.resource?.id || jcEvent.system?.id || null,
            name: jcEvent.resource?.name || jcEvent.system?.hostname || null,
          },
          context: {
            service: jcEvent.service,
            eventType: jcEvent.event_type,
            success,
            timestamp: jcEvent.timestamp,
            clientIp: jcEvent.client_ip || jcEvent.src_ip,
            geoIp: jcEvent.geoip,
            orgId: jcEvent.organization,
            platformId: context.platformId,
          },
        });
      }

      // JumpCloud uses search_after for pagination (from last event's sort value)
      const lastEvent = jcEvents[jcEvents.length - 1];
      if (lastEvent?.id && jcEvents.length >= 100) {
        searchAfter = { id: lastEvent.id };
        cursor.searchAfter = searchAfter;
      } else {
        delete cursor.searchAfter;
        break;
      }
    }
  } catch (err) {
    errors.push(`JumpCloud events: ${(err as Error).message}`);
  }

  return { events, cursor, errors };
}
