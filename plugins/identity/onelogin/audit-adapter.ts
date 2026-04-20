/**
 * OneLogin Audit Adapter
 *
 * Polls OneLogin Events API for:
 * - Authentication events (login success/failure)
 * - User lifecycle (create/update/delete/lock)
 * - App provisioning events
 * - Role assignments
 *
 * Uses: https://{subdomain}.onelogin.com/api/1/events
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
  oneloginSubdomain?: string;
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

interface OneLoginEvent {
  event_type_id: number;
  event_type_name?: string;
  created_at?: string;
  actor_user_id?: number;
  actor_user_name?: string;
  user_id?: number;
  user_name?: string;
  app_id?: number;
  app_name?: string;
  account_id?: number;
  directory_id?: number;
  role_id?: number;
  role_name?: string;
  ipaddr?: string;
  notes?: string;
  error_description?: string;
}

interface OneLoginEventsResponse {
  data?: OneLoginEvent[];
  pagination?: { after_cursor?: string };
}

const MAX_PAGES = 5;

// ─── OneLogin Event Type IDs → Mapped Event Types ────────────────────────────
// OneLogin events use numeric type IDs. Key event type IDs:

const EVENT_TYPE_MAP: Record<number, string> = {
  // Authentication
  5: 'platform.onelogin.user.login',           // User logged in
  6: 'platform.onelogin.user.login_failed',     // User login failed
  8: 'platform.onelogin.user.login',           // User logged into app (SSO)
  10: 'platform.onelogin.user.login_failed',    // User failed to log into app

  // User lifecycle
  14: 'platform.onelogin.user.created',         // User created
  15: 'platform.onelogin.user.deleted',         // User deleted
  16: 'platform.onelogin.user.updated',         // User updated
  17: 'platform.onelogin.user.locked',          // User locked
  18: 'platform.onelogin.user.updated',         // User unlocked
  19: 'platform.onelogin.user.updated',         // User activated
  20: 'platform.onelogin.user.updated',         // User suspended
  21: 'platform.onelogin.user.updated',         // User reactivated

  // Password
  22: 'platform.onelogin.user.password_changed', // Password changed
  23: 'platform.onelogin.user.password_changed', // Password reset

  // App provisioning
  31: 'platform.onelogin.app.provisioned',       // App provisioned to user
  32: 'platform.onelogin.app.deprovisioned',     // App deprovisioned from user

  // Role
  36: 'platform.onelogin.role.assigned',         // Role assigned
  37: 'platform.onelogin.role.removed',          // Role removed

  // Privilege
  46: 'platform.onelogin.user.updated',         // User privilege granted
  47: 'platform.onelogin.user.updated',         // User privilege revoked
};

function mapEventTypeId(eventTypeId: number): string {
  return EVENT_TYPE_MAP[eventTypeId] || `platform.onelogin.event.type_${eventTypeId || 'unknown'}`;
}

function severityForEvent(eventType: string): string {
  if (eventType.includes('login_failed')) return 'warning';
  if (eventType.includes('deleted') || eventType.includes('locked')) return 'warning';
  if (eventType.includes('password_changed')) return 'warning';
  if (eventType.includes('deprovisioned')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll OneLogin audit events.
 *
 * @param accessToken - Valid OneLogin OAuth bearer token
 * @param since - Only return events after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor, oneloginSubdomain }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  const subdomain = context.oneloginSubdomain;
  if (!subdomain) {
    errors.push('OneLogin subdomain not configured in context.oneloginSubdomain');
    return { events, cursor, errors };
  }

  const baseUrl = `https://${subdomain}.onelogin.com`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const sinceISO = since.toISOString();
  let afterCursor: string | null = (cursor.afterCursor as string) || null;
  let pageCount = 0;

  try {
    while (pageCount < MAX_PAGES) {
      pageCount++;

      let url = `${baseUrl}/api/1/events?since=${encodeURIComponent(sinceISO)}&limit=50`;
      if (afterCursor) {
        url += `&after_cursor=${afterCursor}`;
      }

      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status === 401) {
          // Try to get a fresh token — but for now just report
          errors.push(`OneLogin events: ${res.status} Unauthorized — token may need refresh`);
        } else if (res.status !== 403) {
          errors.push(`OneLogin events: ${res.status} ${errText}`);
        }
        break;
      }

      const data = await res.json() as OneLoginEventsResponse;
      const olEvents = data.data || [];

      if (olEvents.length === 0) {
        break;
      }

      for (const olEvent of olEvents) {
        const eventType = mapEventTypeId(olEvent.event_type_id);

        events.push({
          eventType,
          source: 'onelogin',
          severity: severityForEvent(eventType),
          actor: {
            id: olEvent.actor_user_id?.toString() || null,
            email: olEvent.actor_user_name || 'system',
            type: olEvent.actor_user_id ? 'user' : 'system',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: olEvent.user_id ? 'user' : olEvent.app_id ? 'app' : 'unknown',
            id: olEvent.user_id?.toString() || olEvent.app_id?.toString() || null,
            name: olEvent.user_name || olEvent.app_name || null,
          },
          context: {
            eventTypeId: olEvent.event_type_id,
            eventTypeName: olEvent.event_type_name,
            createdAt: olEvent.created_at,
            ipAddress: olEvent.ipaddr,
            notes: olEvent.notes,
            errorDescription: olEvent.error_description,
            userId: olEvent.user_id,
            userName: olEvent.user_name,
            appId: olEvent.app_id,
            appName: olEvent.app_name,
            accountId: olEvent.account_id,
            directoryId: olEvent.directory_id,
            roleId: olEvent.role_id,
            roleName: olEvent.role_name,
            platformId: context.platformId,
          },
        });
      }

      // Handle cursor-based pagination
      if (data.pagination?.after_cursor) {
        afterCursor = data.pagination.after_cursor;
        cursor.afterCursor = afterCursor;
      } else {
        delete cursor.afterCursor;
        break;
      }
    }
  } catch (err) {
    errors.push(`OneLogin events: ${(err as Error).message}`);
  }

  return { events, cursor, errors };
}
