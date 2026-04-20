/**
 * Google Ads Audit Adapter
 *
 * Polls Google Ads API change events for:
 * - Campaign create/update/delete
 * - Budget changes
 * - User access changes
 *
 * Uses: Google Ads API v16 ChangeEvent resource via googleads.googleapis.com
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, string>;
  developerToken?: string;
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
  cursor: Record<string, string>;
  errors: string[];
}

interface GoogleAdsChangeEvent {
  changeResourceType?: string;
  changeResourceName?: string;
  resourceChangeOperation?: string;
  userEmail?: string;
  clientType?: string;
  changeDateTime?: string;
}

interface GoogleAdsRow {
  changeEvent?: GoogleAdsChangeEvent;
  campaign?: { name?: string; id?: string };
}

interface GoogleAdsSearchResponse {
  results?: GoogleAdsRow[];
  nextPageToken?: string;
}

const GOOGLE_ADS_API = 'https://googleads.googleapis.com/v16';
const MAX_PAGES = 5;

// ─── Resource/Change Type Mapping ────────────────────────────────────────────

const RESOURCE_CHANGE_MAP: Record<string, string> = {
  CAMPAIGN: 'campaign',
  AD_GROUP: 'ad_group',
  AD: 'ad',
  CAMPAIGN_BUDGET: 'budget',
  BIDDING_STRATEGY: 'bidding_strategy',
  AD_GROUP_AD: 'ad',
  AD_GROUP_CRITERION: 'criterion',
  CAMPAIGN_CRITERION: 'criterion',
  CUSTOMER: 'account',
};

const CHANGE_STATUS_MAP: Record<string, string> = {
  ADDED: 'created',
  CHANGED: 'updated',
  REMOVED: 'deleted',
};

function mapToEventType(resourceType: string, changeStatus: string): string {
  const resource = RESOURCE_CHANGE_MAP[resourceType] || resourceType?.toLowerCase() || 'unknown';
  const action = CHANGE_STATUS_MAP[changeStatus] || changeStatus?.toLowerCase() || 'changed';

  // Special handling for budget-specific changes
  if (resourceType === 'CAMPAIGN_BUDGET' && changeStatus === 'CHANGED') {
    return 'platform.google-ads.budget.changed';
  }

  return `platform.google-ads.${resource}.${action}`;
}

function severityForEvent(eventType: string): string {
  if (eventType.includes('user.') || eventType.includes('budget.changed')) return 'warning';
  if (eventType.includes('deleted')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll Google Ads change events.
 *
 * @param accessToken - Valid OAuth access token with adwords scope
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  // List accessible customers
  let customerIds: string[] = [];
  try {
    const listRes = await fetch(`${GOOGLE_ADS_API}/customers:listAccessibleCustomers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (listRes.ok) {
      const data = await listRes.json() as { resourceNames?: string[] };
      customerIds = (data.resourceNames || []).map(rn => rn.replace('customers/', ''));
    } else {
      const errText = await listRes.text();
      errors.push(`Failed to list customers: ${listRes.status} ${errText}`);
    }
  } catch (err) {
    errors.push(`Failed to list customers: ${(err as Error).message}`);
    return { events, cursor, errors };
  }

  const sinceStr = since.toISOString().replace('T', ' ').replace('Z', '+00:00').slice(0, 23) + '+00:00';

  for (const customerId of customerIds) {
    let pageToken: string | null = cursor[customerId] || null;
    let pageCount = 0;

    try {
      while (pageCount < MAX_PAGES) {
        pageCount++;

        const query = `
          SELECT
            change_event.change_date_time,
            change_event.change_resource_type,
            change_event.change_resource_name,
            change_event.resource_change_operation,
            change_event.user_email,
            change_event.client_type,
            change_event.old_resource,
            change_event.new_resource,
            campaign.name,
            campaign.id
          FROM change_event
          WHERE change_event.change_date_time >= '${sinceStr}'
          ORDER BY change_event.change_date_time ASC
          LIMIT 1000
        `.trim();

        const body: Record<string, unknown> = { query };
        if (pageToken) body.pageToken = pageToken;

        const res = await fetch(`${GOOGLE_ADS_API}/customers/${customerId}/googleAds:searchStream`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'developer-token': context.developerToken || '',
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text();
          // 403/PERMISSION_DENIED means no access — skip silently
          if (res.status !== 403) {
            errors.push(`customer/${customerId}: ${res.status} ${errText}`);
          }
          break;
        }

        const data = await res.json() as GoogleAdsSearchResponse[] | GoogleAdsSearchResponse;
        const results = Array.isArray(data) ? (data[0] as GoogleAdsSearchResponse)?.results || [] : (data as GoogleAdsSearchResponse).results || [];

        for (const row of results) {
          const ce = row.changeEvent || {};
          const eventType = mapToEventType(ce.changeResourceType || '', ce.resourceChangeOperation || '');

          events.push({
            eventType,
            source: 'google-ads',
            severity: severityForEvent(eventType),
            actor: {
              id: ce.userEmail || null,
              email: ce.userEmail || 'system',
              type: ce.userEmail ? 'user' : 'system',
            },
            agency: { id: context.agencyId, slug: context.agencySlug },
            resource: {
              type: RESOURCE_CHANGE_MAP[ce.changeResourceType || ''] || 'unknown',
              id: ce.changeResourceName || null,
              name: row.campaign?.name || ce.changeResourceName || null,
            },
            context: {
              customerId,
              changeTime: ce.changeDateTime,
              changeResourceType: ce.changeResourceType,
              resourceChangeOperation: ce.resourceChangeOperation,
              clientType: ce.clientType,
              platformId: context.platformId,
            },
          });
        }

        // Handle pagination
        const nextPageToken = Array.isArray(data) ? (data[0] as GoogleAdsSearchResponse)?.nextPageToken : (data as GoogleAdsSearchResponse).nextPageToken;
        if (nextPageToken) {
          pageToken = nextPageToken;
          cursor[customerId] = nextPageToken;
        } else {
          delete cursor[customerId];
          break;
        }
      }
    } catch (err) {
      errors.push(`customer/${customerId}: ${(err as Error).message}`);
    }
  }

  return { events, cursor, errors };
}
