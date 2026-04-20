/**
 * Salesforce Audit Adapter
 *
 * Polls Salesforce audit/activity APIs for:
 * - SetupAuditTrail — admin configuration changes
 * - LoginHistory — user login events
 *
 * Uses:
 * - /services/data/v59.0/query?q=SELECT ... FROM SetupAuditTrail
 * - /services/data/v59.0/query?q=SELECT ... FROM LoginHistory
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, unknown>;
  instanceUrl?: string;
}

interface AuditEvent {
  eventType: string;
  source: string;
  severity: string;
  actor: { id: string | null; email: string; type: string };
  agency: { id: string; slug: string };
  resource: { type: string; id: string; name: string | null };
  context: Record<string, unknown>;
}

interface AuditAdapterResult {
  events: AuditEvent[];
  cursor: Record<string, unknown>;
  errors: string[];
}

interface SfSetupAuditRecord {
  Id: string;
  Action: string;
  CreatedById?: string;
  CreatedBy?: { Username?: string };
  CreatedDate: string;
  Display?: string;
  Section?: string;
  DelegateUser?: string;
}

interface SfLoginRecord {
  Id: string;
  UserId?: string;
  LoginTime: string;
  SourceIp?: string;
  LoginType?: string;
  Status?: string;
  Application?: string;
  Browser?: string;
  Platform?: string;
}

interface SfQueryResponse<T> {
  records?: T[];
  nextRecordsUrl?: string;
}

const SF_API_VERSION = 'v59.0';
const MAX_PAGES = 5;

// ─── Event Type Mapping ──────────────────────────────────────────────────────

const SETUP_ACTION_MAP: Record<string, string> = {
  // User management
  'insertedUser': 'platform.salesforce.user.created',
  'createdUser': 'platform.salesforce.user.created',
  'deactivatedUser': 'platform.salesforce.user.deactivated',
  'activatedUser': 'platform.salesforce.user.created',
  'frozeUser': 'platform.salesforce.user.deactivated',
  'unfrozeUser': 'platform.salesforce.user.created',
  'changedUserPassword': 'platform.salesforce.user.password_changed',
  'resetUserPassword': 'platform.salesforce.user.password_changed',
  // Permission/profile changes
  'changedPermSetAssignment': 'platform.salesforce.permission.changed',
  'changedProfile': 'platform.salesforce.profile.changed',
  'createdPermissionSet': 'platform.salesforce.permission.changed',
  'deletedPermissionSet': 'platform.salesforce.permission.changed',
  'changedRole': 'platform.salesforce.permission.changed',
  // Security settings
  'changedIpRange': 'platform.salesforce.setup.changed',
  'changedPasswordPolicy': 'platform.salesforce.setup.changed',
  'changedSessionSettings': 'platform.salesforce.setup.changed',
  'enabledTwoFactor': 'platform.salesforce.setup.changed',
};

function mapSetupAction(action: string | undefined): string {
  if (!action) return 'platform.salesforce.setup.changed';

  // Check direct mapping
  for (const [key, eventType] of Object.entries(SETUP_ACTION_MAP)) {
    if (action.toLowerCase().includes(key.toLowerCase())) {
      return eventType;
    }
  }

  return 'platform.salesforce.setup.changed';
}

function severityForEvent(eventType: string): string {
  if (eventType.includes('login_failed')) return 'warning';
  if (eventType.includes('deactivated')) return 'warning';
  if (eventType.includes('permission.changed')) return 'warning';
  if (eventType.includes('password_changed')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll Salesforce audit events.
 *
 * @param accessToken - Valid OAuth access token with API access
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor, instanceUrl }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  const instanceUrl = context.instanceUrl || 'https://login.salesforce.com';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const sinceISO = since.toISOString();

  // ── Poll SetupAuditTrail ───────────────────────────────────────────────

  try {
    const query = encodeURIComponent(
      `SELECT Id, Action, CreatedById, CreatedBy.Username, CreatedDate, Display, Section, DelegateUser ` +
      `FROM SetupAuditTrail ` +
      `WHERE CreatedDate > ${sinceISO} ` +
      `ORDER BY CreatedDate ASC ` +
      `LIMIT 200`
    );

    let url: string | null = `${instanceUrl}/services/data/${SF_API_VERSION}/query?q=${query}`;
    let pageCount = 0;

    while (url && pageCount < MAX_PAGES) {
      pageCount++;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status !== 403) {
          errors.push(`SetupAuditTrail: ${res.status} ${errText}`);
        }
        break;
      }

      const data = await res.json() as SfQueryResponse<SfSetupAuditRecord>;
      const records = data.records || [];

      for (const record of records) {
        const eventType = mapSetupAction(record.Action);

        events.push({
          eventType,
          source: 'salesforce',
          severity: severityForEvent(eventType),
          actor: {
            id: record.CreatedById || null,
            email: record.CreatedBy?.Username || 'system',
            type: record.CreatedById ? 'user' : 'system',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: 'setup',
            id: record.Id,
            name: record.Display || record.Action || null,
          },
          context: {
            action: record.Action,
            display: record.Display,
            section: record.Section,
            delegateUser: record.DelegateUser,
            createdDate: record.CreatedDate,
            platformId: context.platformId,
          },
        });
      }

      // Handle pagination via nextRecordsUrl
      url = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
    }
  } catch (err) {
    errors.push(`SetupAuditTrail: ${(err as Error).message}`);
  }

  // ── Poll LoginHistory ──────────────────────────────────────────────────

  try {
    const query = encodeURIComponent(
      `SELECT Id, UserId, LoginTime, SourceIp, LoginType, Status, Application, Browser, Platform ` +
      `FROM LoginHistory ` +
      `WHERE LoginTime > ${sinceISO} ` +
      `ORDER BY LoginTime ASC ` +
      `LIMIT 200`
    );

    let url: string | null = `${instanceUrl}/services/data/${SF_API_VERSION}/query?q=${query}`;
    let pageCount = 0;

    while (url && pageCount < MAX_PAGES) {
      pageCount++;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        const errText = await res.text();
        if (res.status !== 403) {
          errors.push(`LoginHistory: ${res.status} ${errText}`);
        }
        break;
      }

      const data = await res.json() as SfQueryResponse<SfLoginRecord>;
      const records = data.records || [];

      for (const record of records) {
        const isSuccess = record.Status === 'Success' || record.Status === 'LOGIN_NO_ERROR';
        const eventType = isSuccess ? 'platform.salesforce.user.login' : 'platform.salesforce.user.login_failed';

        events.push({
          eventType,
          source: 'salesforce',
          severity: severityForEvent(eventType),
          actor: {
            id: record.UserId || null,
            email: record.UserId || 'unknown',
            type: 'user',
          },
          agency: { id: context.agencyId, slug: context.agencySlug },
          resource: {
            type: 'user',
            id: record.UserId || record.Id,
            name: null,
          },
          context: {
            loginTime: record.LoginTime,
            sourceIp: record.SourceIp,
            loginType: record.LoginType,
            status: record.Status,
            application: record.Application,
            browser: record.Browser,
            loginPlatform: record.Platform,
            platformId: context.platformId,
          },
        });
      }

      url = data.nextRecordsUrl ? `${instanceUrl}${data.nextRecordsUrl}` : null;
    }
  } catch (err) {
    errors.push(`LoginHistory: ${(err as Error).message}`);
  }

  return { events, cursor, errors };
}
