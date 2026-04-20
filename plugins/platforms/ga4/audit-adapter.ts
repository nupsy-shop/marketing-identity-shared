/**
 * GA4 Audit Adapter
 *
 * Polls Google Analytics Admin API change history for:
 * - Account/property changes
 * - Permission grants/revocations
 * - User management events
 *
 * Uses: https://analyticsadmin.googleapis.com/v1alpha/accounts/{id}:searchChangeHistoryEvents
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, string>;
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
  cursor: Record<string, string>;
  errors: string[];
}

interface Ga4Account {
  name: string;
  displayName?: string;
}

interface Ga4Change {
  resourceType: string;
  action: string;
  resource?: string;
  resourceAfterChange?: { displayName?: string; [key: string]: unknown };
  resourceBeforeChange?: { displayName?: string; [key: string]: unknown };
}

interface Ga4ChangeHistoryEvent {
  userActorEmail?: string;
  changeTime?: string;
  changes?: Ga4Change[];
}

interface Ga4SearchResponse {
  changeHistoryEvents?: Ga4ChangeHistoryEvent[];
  nextPageToken?: string;
}

const GA4_ADMIN_API = 'https://analyticsadmin.googleapis.com/v1alpha';

// ─── Change Type → Event Type Mapping ────────────────────────────────────────

const CHANGE_TYPE_MAP: Record<string, string> = {
  'CREATED': 'created',
  'UPDATED': 'updated',
  'DELETED': 'deleted',
};

const RESOURCE_TYPE_MAP: Record<string, string> = {
  'ACCOUNT': 'account',
  'PROPERTY': 'property',
  'GOOGLE_ADS_LINK': 'google_ads_link',
  'FIREBASE_LINK': 'firebase_link',
  'GOOGLE_SIGNALS_SETTINGS': 'settings',
  'DATA_RETENTION_SETTINGS': 'settings',
  'DATA_STREAM': 'data_stream',
  'ATTRIBUTION_SETTINGS': 'settings',
  'MEASUREMENT_PROTOCOL_SECRET': 'measurement_protocol',
  'CUSTOM_DIMENSION': 'custom_dimension',
  'CUSTOM_METRIC': 'custom_metric',
  'CONVERSION_EVENT': 'conversion_event',
  'DISPLAY_VIDEO_360_ADVERTISER_LINK': 'dv360_link',
  'DISPLAY_VIDEO_360_ADVERTISER_LINK_PROPOSAL': 'dv360_link',
  'SEARCH_ADS_360_LINK': 'sa360_link',
  // Access/permission resources
  'ACCESS_BINDING': 'permission',
  'USER_LINK': 'permission',
  // Enhanced measurement
  'ENHANCED_MEASUREMENT_SETTINGS': 'settings',
  'EXPANDED_DATA_SET': 'data_set',
  'CHANNEL_GROUP': 'channel_group',
  'AUDIENCE': 'audience',
  'EVENT_CREATE_RULE': 'event_rule',
  'CALCULATED_METRIC': 'calculated_metric',
  'DATA_REDACTION_SETTINGS': 'settings',
  'SK_AD_NETWORK_CONVERSION_VALUE_SCHEMA': 'settings',
  'ADSENSE_LINK': 'adsense_link',
  'BIGQUERY_LINK': 'bigquery_link',
  'SUBPROPERTY_EVENT_FILTER': 'event_filter',
};

function mapChangeToEventType(change: Ga4Change): string {
  const resourceType = RESOURCE_TYPE_MAP[change.resourceType] || change.resourceType?.toLowerCase() || 'unknown';
  const action = CHANGE_TYPE_MAP[change.action] || change.action?.toLowerCase() || 'changed';

  // Special handling for permission-related changes
  if ((change.resourceType === 'ACCESS_BINDING' || change.resourceType === 'USER_LINK') && change.action === 'CREATED') {
    return 'platform.ga4.permission.granted';
  }
  if ((change.resourceType === 'ACCESS_BINDING' || change.resourceType === 'USER_LINK') && change.action === 'DELETED') {
    return 'platform.ga4.permission.revoked';
  }
  if ((change.resourceType === 'ACCESS_BINDING' || change.resourceType === 'USER_LINK') && change.action === 'UPDATED') {
    return 'platform.ga4.permission.updated';
  }

  return `platform.ga4.${resourceType}.${action}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll GA4 change history events.
 *
 * @param accessToken - Valid OAuth access token with analytics.edit scope
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];

  // Get all accessible accounts
  let accounts: Ga4Account[] = [];
  try {
    const accountsRes = await fetch(`${GA4_ADMIN_API}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (accountsRes.ok) {
      const data = await accountsRes.json() as { accounts?: Ga4Account[] };
      accounts = data.accounts || [];
    }
  } catch (err) {
    errors.push(`Failed to list accounts: ${(err as Error).message}`);
  }

  // For each account, search change history
  for (const account of accounts) {
    const accountId = account.name; // e.g., 'accounts/12345'
    try {
      const body: Record<string, unknown> = {
        earliestChangeTime: since.toISOString(),
        latestChangeTime: new Date().toISOString(),
        pageSize: 100,
      };

      // Use cursor for pagination if available
      if (context.cursor?.[accountId]) {
        body.pageToken = context.cursor[accountId];
      }

      const res = await fetch(`${GA4_ADMIN_API}/${accountId}:searchChangeHistoryEvents`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        // 403 means no access to this account's change history — skip silently
        if (res.status !== 403) {
          errors.push(`${accountId}: ${res.status} ${errText}`);
        }
        continue;
      }

      const data = await res.json() as Ga4SearchResponse;
      const changeEvents = data.changeHistoryEvents || [];

      for (const event of changeEvents) {
        for (const change of event.changes || []) {
          const eventType = mapChangeToEventType(change);
          const resourceAfter = change.resourceAfterChange || {};
          const resourceBefore = change.resourceBeforeChange || {};

          events.push({
            eventType,
            source: 'ga4',
            severity: eventType.includes('permission') ? 'warning' : 'info',
            actor: {
              id: event.userActorEmail || null,
              email: event.userActorEmail || 'system',
              type: event.userActorEmail ? 'user' : 'system',
            },
            agency: { id: context.agencyId, slug: context.agencySlug },
            resource: {
              type: RESOURCE_TYPE_MAP[change.resourceType] || 'unknown',
              id: change.resource || accountId,
              name: resourceAfter.displayName || resourceBefore.displayName || change.resource || null,
            },
            context: {
              accountId,
              accountName: account.displayName,
              changeType: change.action,
              resourceType: change.resourceType,
              resource: change.resource,
              changeTime: event.changeTime,
              platformId: context.platformId,
            },
          });
        }
      }

      // Store pagination cursor
      if (data.nextPageToken) {
        if (!context.cursor) context.cursor = {} as Record<string, string>;
        context.cursor[accountId] = data.nextPageToken;
      }
    } catch (err) {
      errors.push(`${accountId}: ${(err as Error).message}`);
    }
  }

  return { events, cursor: context.cursor || {}, errors };
}
