/**
 * Google Tag Manager Audit Adapter
 *
 * Polls GTM version history for:
 * - Container version creation (publishes)
 * - Tag/trigger/variable changes tracked via version diffs
 *
 * Uses: https://tagmanager.googleapis.com/tagmanager/v2/accounts/{id}/containers/{id}/version_headers
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
  resource: { type: string; id: string; name: string };
  context: Record<string, unknown>;
}

interface AuditAdapterResult {
  events: AuditEvent[];
  cursor: Record<string, string>;
  errors: string[];
}

interface GtmAccount {
  accountId: string;
  name: string;
  path: string;
}

interface GtmContainer {
  containerId: string;
  name: string;
  path: string;
}

interface GtmVersionHeader {
  containerVersionId: string;
  name?: string;
  email?: string;
  numTags?: string;
  numTriggers?: string;
  numVariables?: string;
}

interface GtmVersionDetail {
  fingerprint?: string;
  tag?: Array<{ tagId: string; name: string; type: string }>;
  trigger?: Array<{ triggerId: string; name: string }>;
  variable?: Array<{ variableId: string; name: string }>;
}

const GTM_API = 'https://tagmanager.googleapis.com/tagmanager/v2';
const MAX_PAGES = 5;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Poll GTM version history events.
 *
 * @param accessToken - Valid OAuth access token with tagmanager.readonly scope
 * @param since - Only return changes after this timestamp
 * @param context - { agencyId, agencySlug, platformId, cursor }
 */
export async function pollAuditEvents(accessToken: string, since: Date, context: AuditAdapterContext): Promise<AuditAdapterResult> {
  const events: AuditEvent[] = [];
  const errors: string[] = [];
  const cursor = context.cursor || {};

  // Step 1: List accounts
  let accounts: GtmAccount[] = [];
  try {
    const accountsRes = await fetch(`${GTM_API}/accounts`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (accountsRes.ok) {
      const data = await accountsRes.json() as { account?: GtmAccount[] };
      accounts = data.account || [];
    } else {
      const errText = await accountsRes.text();
      errors.push(`Failed to list accounts: ${accountsRes.status} ${errText}`);
    }
  } catch (err) {
    errors.push(`Failed to list accounts: ${(err as Error).message}`);
    return { events, cursor, errors };
  }

  // Step 2: For each account, list containers
  for (const account of accounts) {
    let containers: GtmContainer[] = [];
    try {
      const containersRes = await fetch(`${GTM_API}/${account.path}/containers`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (containersRes.ok) {
        const data = await containersRes.json() as { container?: GtmContainer[] };
        containers = data.container || [];
      } else if (containersRes.status !== 403) {
        const errText = await containersRes.text();
        errors.push(`${account.path}: ${containersRes.status} ${errText}`);
      }
    } catch (err) {
      errors.push(`${account.path}: ${(err as Error).message}`);
      continue;
    }

    // Step 3: For each container, list version headers
    for (const container of containers) {
      const containerPath = container.path; // e.g. accounts/123/containers/456
      let pageToken: string | null = cursor[containerPath] || null;
      let pageCount = 0;

      try {
        while (pageCount < MAX_PAGES) {
          pageCount++;

          let url = `${GTM_API}/${containerPath}/version_headers`;
          if (pageToken) url += `?pageToken=${pageToken}`;

          const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });

          if (!res.ok) {
            if (res.status !== 403) {
              const errText = await res.text();
              errors.push(`${containerPath}: ${res.status} ${errText}`);
            }
            break;
          }

          const data = await res.json() as { containerVersionHeader?: GtmVersionHeader[]; nextPageToken?: string };
          const versionHeaders = data.containerVersionHeader || [];

          for (const vh of versionHeaders) {
            // Filter by timestamp — version_headers don't always have a timestamp,
            // but containerVersionId increases monotonically
            // Use the last-seen version ID as cursor
            const lastSeenId = cursor[`${containerPath}_lastVersion`] || '0';
            if (parseInt(vh.containerVersionId, 10) <= parseInt(lastSeenId, 10)) {
              continue;
            }

            // Fetch full version detail for richer event data
            let versionDetail: GtmVersionDetail | null = null;
            try {
              const detailRes = await fetch(
                `${GTM_API}/${containerPath}/versions/${vh.containerVersionId}`,
                { headers: { Authorization: `Bearer ${accessToken}` } }
              );
              if (detailRes.ok) {
                versionDetail = await detailRes.json() as GtmVersionDetail;
              }
            } catch (_) {
              // Non-critical — continue with header data only
            }

            // Emit version_created event
            events.push({
              eventType: 'platform.gtm.container.version_created',
              source: 'gtm',
              severity: 'info',
              actor: {
                id: vh.email || versionDetail?.fingerprint || null,
                email: vh.email || 'system',
                type: vh.email ? 'user' : 'system',
              },
              agency: { id: context.agencyId, slug: context.agencySlug },
              resource: {
                type: 'container_version',
                id: `${containerPath}/versions/${vh.containerVersionId}`,
                name: vh.name || `Version ${vh.containerVersionId}`,
              },
              context: {
                accountId: account.accountId,
                accountName: account.name,
                containerId: container.containerId,
                containerName: container.name,
                versionId: vh.containerVersionId,
                numTags: vh.numTags,
                numTriggers: vh.numTriggers,
                numVariables: vh.numVariables,
                platformId: context.platformId,
              },
            });

            // If we have detail, emit individual tag/trigger/variable events
            if (versionDetail) {
              for (const tag of versionDetail.tag || []) {
                events.push({
                  eventType: `platform.gtm.tag.updated`,
                  source: 'gtm',
                  severity: 'info',
                  actor: {
                    id: vh.email || null,
                    email: vh.email || 'system',
                    type: vh.email ? 'user' : 'system',
                  },
                  agency: { id: context.agencyId, slug: context.agencySlug },
                  resource: {
                    type: 'tag',
                    id: tag.tagId,
                    name: tag.name,
                  },
                  context: {
                    containerPath,
                    versionId: vh.containerVersionId,
                    tagType: tag.type,
                    platformId: context.platformId,
                  },
                });
              }
            }

            // Update cursor to track last seen version
            cursor[`${containerPath}_lastVersion`] = vh.containerVersionId;
          }

          // Handle pagination
          if (data.nextPageToken) {
            pageToken = data.nextPageToken;
            cursor[containerPath] = data.nextPageToken;
          } else {
            delete cursor[containerPath];
            break;
          }
        }
      } catch (err) {
        errors.push(`${containerPath}: ${(err as Error).message}`);
      }
    }
  }

  return { events, cursor, errors };
}
