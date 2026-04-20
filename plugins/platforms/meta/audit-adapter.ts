/**
 * Meta (Facebook) Audit Adapter
 *
 * Polls Meta Marketing API ad account activities for:
 * - Campaign/ad set/ad create/update/delete
 * - Budget changes
 * - User access changes
 *
 * Uses: https://graph.facebook.com/v19.0/act_{ad_account_id}/activities
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface AuditAdapterContext {
  agencyId: string;
  agencySlug: string;
  platformId: string;
  cursor: Record<string, string>;
  adAccountIds?: string[];
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

interface MetaActivity {
  event_type?: string;
  event_time?: string;
  actor_id?: string;
  actor_name?: string;
  extra_data?: string;
  object_id?: string;
  object_name?: string;
}

interface MetaActivitiesResponse {
  data?: MetaActivity[];
  paging?: { cursors?: { after?: string }; next?: string };
}

const GRAPH_API = 'https://graph.facebook.com/v19.0';
const MAX_PAGES = 5;

// ─── Event Category Mapping ──────────────────────────────────────────────────

const EVENT_TYPE_MAP: Record<string, string> = {
  // Ad-level events
  'ad_account_update_spend_limit': 'platform.meta.campaign.budget_changed',
  'ad_account_set_business_information': 'platform.meta.account.updated',
  'ad_account_billing_charge': 'platform.meta.account.billing_charged',
  // Campaign events
  'campaign_created': 'platform.meta.campaign.created',
  'campaign_updated': 'platform.meta.campaign.updated',
  'campaign_deleted': 'platform.meta.campaign.deleted',
  'campaign_paused': 'platform.meta.campaign.updated',
  // Ad set events
  'adset_created': 'platform.meta.adset.created',
  'adset_updated': 'platform.meta.adset.updated',
  'adset_deleted': 'platform.meta.adset.deleted',
  'adset_paused': 'platform.meta.adset.updated',
  'adset_budget_updated': 'platform.meta.campaign.budget_changed',
  // Ad events
  'ad_created': 'platform.meta.ad.created',
  'ad_updated': 'platform.meta.ad.updated',
  'ad_deleted': 'platform.meta.ad.deleted',
  // User events
  'user_added': 'platform.meta.user.added',
  'user_removed': 'platform.meta.user.removed',
  'user_role_changed': 'platform.meta.user.added',
  // Funding
  'funding_event_initiated': 'platform.meta.account.funding_changed',
  'funding_event_completed': 'platform.meta.account.funding_changed',
};

function mapEventType(category: string): string {
  return EVENT_TYPE_MAP[category] || `platform.meta.activity.${category || 'unknown'}`;
}

function severityForEvent(eventType: string): string {
  if (eventType.includes('user.')) return 'warning';
  if (eventType.includes('budget_changed')) return 'warning';
  if (eventType.includes('deleted')) return 'warning';
  return 'info';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll Meta ad account activity events.
 *
 * @param accessToken - Valid OAuth access token with ads_read scope
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor, adAccountIds }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  // Get ad account IDs from context or discover them
  let adAccountIds = context.adAccountIds || [];

  if (adAccountIds.length === 0) {
    // Try to discover ad accounts via the user's business
    try {
      const meRes = await fetch(`${GRAPH_API}/me/adaccounts?fields=account_id,name&access_token=${accessToken}`);
      if (meRes.ok) {
        const data = await meRes.json() as { data?: Array<{ account_id: string; name?: string }> };
        adAccountIds = (data.data || []).map(a => a.account_id);
      } else {
        const errText = await meRes.text();
        errors.push(`Failed to discover ad accounts: ${meRes.status} ${errText}`);
      }
    } catch (err) {
      errors.push(`Failed to discover ad accounts: ${(err as Error).message}`);
      return { events, cursor, errors };
    }
  }

  const sinceUnix = Math.floor(since.getTime() / 1000);

  for (const accountId of adAccountIds) {
    const actAccountId = accountId.startsWith('act_') ? accountId : `act_${accountId}`;
    let afterCursor: string | null = cursor[actAccountId] || null;
    let pageCount = 0;

    try {
      while (pageCount < MAX_PAGES) {
        pageCount++;

        let url = `${GRAPH_API}/${actAccountId}/activities?` +
          `fields=event_type,event_time,actor_id,actor_name,extra_data,object_id,object_name` +
          `&since=${sinceUnix}` +
          `&limit=100` +
          `&access_token=${accessToken}`;

        if (afterCursor) {
          url += `&after=${afterCursor}`;
        }

        const res = await fetch(url);

        if (!res.ok) {
          const errText = await res.text();
          // OAuthException with code 100 often means no permission — skip
          if (res.status !== 400) {
            errors.push(`${actAccountId}: ${res.status} ${errText}`);
          }
          break;
        }

        const data = await res.json() as MetaActivitiesResponse;
        const activities = data.data || [];

        for (const activity of activities) {
          const eventType = mapEventType(activity.event_type || '');

          events.push({
            eventType,
            source: 'meta',
            severity: severityForEvent(eventType),
            actor: {
              id: activity.actor_id || null,
              email: activity.actor_name || 'system',
              type: activity.actor_id ? 'user' : 'system',
            },
            agency: { id: context.agencyId, slug: context.agencySlug },
            resource: {
              type: activity.event_type?.includes('campaign') ? 'campaign'
                : activity.event_type?.includes('adset') ? 'adset'
                : activity.event_type?.includes('ad_') ? 'ad'
                : 'account',
              id: activity.object_id || actAccountId,
              name: activity.object_name || null,
            },
            context: {
              adAccountId: actAccountId,
              eventType: activity.event_type,
              eventTime: activity.event_time,
              extraData: activity.extra_data,
              platformId: context.platformId,
            },
          });
        }

        // Handle cursor-based pagination
        const nextCursor = data.paging?.cursors?.after;
        if (nextCursor && data.paging?.next) {
          afterCursor = nextCursor;
          cursor[actAccountId] = nextCursor;
        } else {
          delete cursor[actAccountId];
          break;
        }
      }
    } catch (err) {
      errors.push(`${actAccountId}: ${(err as Error).message}`);
    }
  }

  return { events, cursor, errors };
}
