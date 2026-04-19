/**
 * Per-agency access-analytics aggregate warmer (#59).
 *
 * Runs hourly. For a single agency:
 *   1. Fetch all validated/pending/drift grants (agency_id filter).
 *   2. Build the concentration cell list from the manifest role map.
 *   3. Fetch 90 days of access.granted/revoked from ES (agency-scoped).
 *   4. Build the trend series.
 *   5. Upsert both into access_analytics_snapshots.
 *   6. Emit `analytics.snapshot.refreshed` audit event.
 *
 * Invariants:
 *   - No cross-agency scans. Every query filters on agencyId.
 *   - No new risk math. Blindspots are NOT warmed here — they are
 *     live-computed from the risk scorer at request time.
 *   - No raw SQL. Prisma + the shared ES client only.
 *
 * Entitlement check is the caller's responsibility (manifest map is also
 * supplied by the caller — the shared lib doesn't know about the plugin
 * registry).
 */

import { getRuntime } from '../runtime.js';
import { queryAuditEvents } from '../audit/query.js';
import { publishAuditEvent } from '../audit/publisher.js';
import {
  buildConcentration,
  type ConcentrationGrant,
} from './concentration.js';
import { buildTrends, type TrendAuditEvent } from './trends.js';
import {
  writeConcentrationSnapshot,
  writeTrendSnapshot,
} from './snapshots-db.js';
import type { RoleCategoryMap } from './role-categories.js';

const TREND_DAYS = 90;

export interface RefreshAccessAnalyticsOptions {
  agencyId: string;
  /** Plugin-provided role-category map, keyed by platformKey. */
  manifestMap: Record<string, RoleCategoryMap | undefined>;
  /** Inject agency slug for audit-event richness. Optional. */
  agencySlug?: string | null;
  now?: Date;
  dryRun?: boolean;
}

export interface RefreshAccessAnalyticsStats {
  cellCount: number;
  trendDays: number;
  totalUsersInAgency: number;
  grantsScanned: number;
}

export async function refreshAccessAnalyticsForAgency(
  opts: RefreshAccessAnalyticsOptions,
): Promise<RefreshAccessAnalyticsStats> {
  const { prisma, logger } = getRuntime();
  const capturedAt = opts.now ?? new Date();
  const agencyId = opts.agencyId;

  // 1. Fetch grants agency-scoped.
  const items = await prisma.access_request_items.findMany({
    where: {
      agency_id: agencyId,
      status: { in: ['validated', 'pending', 'drift'] },
    },
    include: {
      access_requests: { select: { requestedBy: true } },
      catalog_platforms: { select: { slug: true } },
    },
  });

  const grants: ConcentrationGrant[] = [];
  const users = new Set<string>();
  for (const row of items) {
    const userId = row.access_requests?.requestedBy;
    const platformKey = row.catalog_platforms?.slug;
    if (!userId || !platformKey) continue;
    grants.push({
      platformKey,
      role: row.role || '',
      userId,
    });
    users.add(userId);
  }
  const totalUsersInAgency = users.size;

  // 2. Concentration cells.
  const cells = buildConcentration({ grants, manifestMap: opts.manifestMap, totalUsersInAgency });

  // 3. Trend events.
  const events = await fetchTrendEvents(agencyId, capturedAt, logger);

  // 4. Trend series.
  const series = buildTrends({ events, days: TREND_DAYS, endDay: capturedAt });

  if (opts.dryRun) {
    logger.info('refresh-access-analytics: dry-run skipped writes', {
      agencyId,
      cellCount: cells.length,
      trendDays: series.length,
      totalUsersInAgency,
    });
    return {
      cellCount: cells.length,
      trendDays: series.length,
      totalUsersInAgency,
      grantsScanned: grants.length,
    };
  }

  // 5. Upsert snapshots.
  await writeConcentrationSnapshot({ agencyId, totalUsersInAgency, cells, capturedAt });
  await writeTrendSnapshot({ agencyId, series, capturedAt });

  // 6. Emit audit event — payload is counts only, NEVER PII.
  try {
    await publishAuditEvent({
      eventType: 'analytics.snapshot.refreshed',
      severity: 'info',
      source: 'refresh-access-analytics',
      actor: { id: 'system', email: 'system', type: 'system' },
      agency: { id: agencyId, slug: opts.agencySlug ?? null },
      context: {
        cellCount: cells.length,
        trendDays: series.length,
        totalUsersInAgency,
      },
    });
  } catch (err) {
    logger.warn('refresh-access-analytics: audit publish failed', {
      agencyId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('refresh-access-analytics: refreshed agency', {
    agencyId,
    cellCount: cells.length,
    trendDays: series.length,
    totalUsersInAgency,
  });

  return {
    cellCount: cells.length,
    trendDays: series.length,
    totalUsersInAgency,
    grantsScanned: grants.length,
  };
}

async function fetchTrendEvents(
  agencyId: string,
  endDay: Date,
  logger: ReturnType<typeof getRuntime>['logger'],
): Promise<TrendAuditEvent[]> {
  const from = new Date(endDay);
  from.setUTCDate(from.getUTCDate() - TREND_DAYS);

  const all: TrendAuditEvent[] = [];
  for (const eventType of ['access.granted', 'access.revoked'] as const) {
    try {
      const result = await queryAuditEvents({
        agencyId,
        eventType,
        dateFrom: from,
        dateTo: endDay,
        limit: 10000,
      });
      for (const ev of result.data) {
        all.push({
          timestamp: ev.timestamp,
          eventType: ev.eventType || ev.type || '',
          userId: ((ev.target as { id?: string } | undefined)?.id
            || (ev.actor as { id?: string } | undefined)?.id
            || null) as string | null,
        });
      }
    } catch (err) {
      logger.warn('refresh-access-analytics: ES fetch failed', {
        agencyId,
        eventType,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return all;
}
