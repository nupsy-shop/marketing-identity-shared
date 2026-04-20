/**
 * Okta Audit Adapter
 *
 * Polls Okta System Log API for:
 * - Authentication events (login success/failure)
 * - User lifecycle (create/deactivate/suspend)
 * - Group membership changes
 * - App assignments
 * - Policy changes
 *
 * Uses: https://{domain}/api/v1/logs
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
  oktaDomain?: string;
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

interface OktaLogEvent {
  eventType: string;
  published: string;
  severity: string;
  displayMessage: string;
  uuid: string;
  outcome?: { result?: string; reason?: string };
  actor?: { id?: string; type?: string; alternateId?: string; displayName?: string };
  target?: Array<{ id?: string; type?: string; displayName?: string; alternateId?: string }>;
  client?: { ipAddress?: string; device?: string; operatingSystem?: string; browser?: string };
}

const MAX_PAGES = 5;

// ─── Okta Event Type Mapping ─────────────────────────────────────────────────

const OKTA_EVENT_MAP: Record<string, string> = {
  // Authentication
  'user.session.start': 'platform.okta.user.login',
  'user.authentication.auth_via_mfa': 'platform.okta.user.login',
  'user.authentication.sso': 'platform.okta.user.login',
  'user.authentication.auth_via_IDP': 'platform.okta.user.login',
  'core.user_auth.login_success': 'platform.okta.user.login',
  'core.user_auth.login_failed': 'platform.okta.user.login_failed',
  'user.session.access_admin_app': 'platform.okta.user.login',
  'user.authentication.auth_via_radius': 'platform.okta.user.login',

  // User lifecycle
  'user.lifecycle.create': 'platform.okta.user.created',
  'user.lifecycle.activate': 'platform.okta.user.created',
  'user.lifecycle.deactivate': 'platform.okta.user.deactivated',
  'user.lifecycle.suspend': 'platform.okta.user.suspended',
  'user.lifecycle.unsuspend': 'platform.okta.user.created',
  'user.lifecycle.delete.initiated': 'platform.okta.user.deactivated',
  'user.account.update_password': 'platform.okta.user.password_changed',
  'user.account.reset_password': 'platform.okta.user.password_changed',

  // Group membership
  'group.user_membership.add': 'platform.okta.group.member_added',
  'group.user_membership.remove': 'platform.okta.group.member_removed',

  // App assignment
  'application.user_membership.add': 'platform.okta.app.assigned',
  'application.user_membership.remove': 'platform.okta.app.unassigned',
  'application.user_membership.change_username': 'platform.okta.app.assigned',

  // Policy
  'policy.lifecycle.create': 'platform.okta.policy.changed',
  'policy.lifecycle.update': 'platform.okta.policy.changed',
  'policy.lifecycle.delete': 'platform.okta.policy.changed',
  'policy.rule.create': 'platform.okta.policy.changed',
  'policy.rule.update': 'platform.okta.policy.changed',
  'policy.rule.delete': 'platform.okta.policy.changed',
};

function mapOktaEventType(oktaEventType: string): string {
  return OKTA_EVENT_MAP[oktaEventType] || `platform.okta.event.${(oktaEventType || 'unknown').replace(/\./g, '_')}`;
}

function severityForEvent(eventType: string, outcome?: string): string {
  if (eventType.includes('login_failed')) return 'warning';
  if (eventType.includes('deactivated') || eventType.includes('suspended')) return 'warning';
  if (eventType.includes('password_changed')) return 'warning';
  if (eventType.includes('policy.changed')) return 'warning';
  if (outcome === 'FAILURE' || outcome === 'DENY') return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll Okta System Log events.
 *
 * @param accessToken - Valid OAuth access token or API token with okta.logs.read scope
 * @param since - Only return events after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor, oktaDomain }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  const oktaDomain = context.oktaDomain;
  if (!oktaDomain) {
    errors.push('Okta domain not configured in context.oktaDomain');
    return { events, cursor, errors };
  }

  const baseUrl = oktaDomain.startsWith('https://') ? oktaDomain : `https://${oktaDomain}`;
  const headers: Record<string, string> = {
    Authorization: `SSWS ${accessToken}`,
    Accept: 'application/json',
  };

  // If the token looks like a Bearer token (from OAuth), use Bearer format
  if (accessToken.length > 50 && accessToken.includes('.')) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const sinceISO = since.toISOString();
  let nextUrl: string | null = (cursor.nextUrl as string) || `${baseUrl}/api/v1/logs?since=${sinceISO}&limit=100&sortOrder=ASCENDING`;
  let pageCount = 0;

  try {
    while (nextUrl && pageCount < MAX_PAGES) {
      pageCount++;

      const res: Response = await fetch(nextUrl, { headers });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status !== 403) {
          errors.push(`Okta logs: ${res.status} ${errText}`);
        }
        break;
      }

      const logEvents = await res.json() as OktaLogEvent[];

      for (const log of logEvents) {
        const eventType = mapOktaEventType(log.eventType);
        const outcome = log.outcome?.result;

        // Extract actor info
        const actor = log.actor || {};
        // Extract target (first target is usually the primary resource)
        const target = (log.target || [])[0] || {};

        events.push({
          eventType,
          source: 'okta',
          severity: severityForEvent(eventType, outcome),
          actor: {
            id: actor.id || null,
            email: actor.alternateId || actor.displayName || 'system',
            type: actor.type === 'SystemPrincipal' ? 'system' : 'user',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: target.type || log.eventType?.split('.')[0] || 'unknown',
            id: target.id || null,
            name: target.displayName || target.alternateId || null,
          },
          context: {
            oktaEventType: log.eventType,
            outcome: outcome,
            outcomeReason: log.outcome?.reason,
            published: log.published,
            severity: log.severity,
            displayMessage: log.displayMessage,
            uuid: log.uuid,
            clientIp: log.client?.ipAddress,
            clientDevice: log.client?.device,
            clientOs: log.client?.operatingSystem,
            clientBrowser: log.client?.browser,
            platformId: context.platformId,
          },
        });
      }

      // Okta uses Link header for pagination
      const linkHeader: string | null = res.headers.get('link') || res.headers.get('Link');
      nextUrl = null;

      if (linkHeader) {
        const nextMatch: RegExpMatchArray | null = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        if (nextMatch) {
          nextUrl = nextMatch[1];
          cursor.nextUrl = nextUrl;
        }
      }

      if (!nextUrl) {
        delete cursor.nextUrl;
      }
    }
  } catch (err) {
    errors.push(`Okta logs: ${(err as Error).message}`);
  }

  return { events, cursor, errors };
}
