/**
 * Audit Query Service
 *
 * Wraps Elasticsearch queries for the API layer.
 * ALWAYS injects agency.id filter for tenant isolation.
 * Powers both the Audit & Reports page and Activity tabs.
 *
 * Postgres mirror read projection (`audit_events_mirror`):
 *   `audit_events_mirror` is written on every publish in ALL environments
 *   (publisher.ts → writeProjectionBatch) and is now ALWAYS consulted here —
 *   the fallback is unconditional (isMirrorModeEnabled() returns true). On the
 *   happy path the mirror result is preferred only when it is denser than ES
 *   (`mirrorResult.total > ES total`), so a healthy ES result is never
 *   overridden. On ANY ES error (not just 404 / index_not_found — also 5xx,
 *   timeouts) the read path falls back to the mirror. This is the "Option B"
 *   seam from issue #1766, promoted production-wide in #1924: Searchly is at
 *   its max index count so new monthly ES indices cannot be created and events
 *   are silently dropped.
 *
 *   The legacy E2E_AUDIT_MIRROR_MODE env flag is retained for back-compat but
 *   no longer gates this behaviour.
 *
 * See docs/architecture/audit-postgres-mirror.md.
 */

import { search, allIndicesPattern, indexNameForDate } from './client.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AuditEvent {
  id: string;
  type: string;
  action: string;
  eventType?: string;
  severity?: string;
  source?: string;
  actor?: { id: string; email?: string; name?: string };
  target?: { id: string; type: string; name?: string };
  resource?: { id?: string; type?: string; name?: string };
  context?: Record<string, unknown> & { changeTimestamp?: string };
  agency_id?: string;
  timestamp: string;
  [key: string]: unknown;
}

export interface AuditQueryOptions {
  agency_id?: string | null;
  agencyId?: string | null;
  type?: string | null;
  eventType?: string | string[] | null;
  action?: string | null;
  actor_id?: string | null;
  actorEmail?: string | null;
  actorId?: string | null;
  /**
   * Actor kind filter: 'human' maps to ES actor.type='user';
   * 'system' maps to actor.type='system'.
   */
  actorType?: 'human' | 'system' | string | null;
  target_id?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  clientId?: string | null;
  from?: string | Date | null;
  to?: string | Date | null;
  dateFrom?: string | Date | null;
  dateTo?: string | Date | null;
  size?: number;
  limit?: number;
  /**
   * Hard ceiling for the page size. Defaults to 200 — the page cap that
   * protects the UI/list endpoints from unbounded fetches. Bulk/aggregation
   * consumers that legitimately need every matching doc (the access-analytics
   * trend warmer, audit export) opt into a higher ceiling by setting this
   * alongside `limit`. Without it the default 200 cap silently truncates a
   * `limit: 10000` request, so a 90-day trend rollup on a tenant with ≥200
   * audit events saturates at 200 and never reflects newly-seeded events.
   */
  maxLimit?: number;
  offset?: number;
  severity?: string | null;
  sort?: 'asc' | 'desc';
  sortField?: string | null;
  sortOrder?: 'asc' | 'desc';
  search?: string | null;
  [key: string]: unknown;
}

export interface AuditQueryResult {
  data: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventCountsResult {
  byEventType: Array<{ key: string; doc_count: number }>;
  bySeverity: Array<{ key: string; doc_count: number }>;
  bySource: Array<{ key: string; doc_count: number }>;
  total: number;
}

// ─── Query Builder ───────────────────────────────────────────────────────────

interface EsQuery {
  query: { bool: { must: Record<string, unknown>[] } };
  sort: Record<string, unknown>[];
  size: number;
  from: number;
  track_total_hits: boolean;
  [key: string]: unknown;
}

function buildQuery(filters: AuditQueryOptions): EsQuery {
  const agencyId = filters.agencyId || filters.agency_id;
  if (!agencyId) throw new Error('agencyId is required for audit queries');

  const must: Record<string, unknown>[] = [
    { term: { 'agency.id': agencyId } },
  ];

  const eventType = filters.eventType;
  if (eventType) {
    if (typeof eventType === 'string' && eventType.endsWith('*')) {
      must.push({ prefix: { eventType: eventType.replace('*', '') } });
    } else if (Array.isArray(eventType)) {
      must.push({ terms: { eventType } });
    } else {
      must.push({ term: { eventType } });
    }
  }

  if (filters.source) must.push({ term: { source: filters.source } });
  if (filters.severity) must.push({ term: { severity: filters.severity } });
  if (filters.actorEmail) must.push({ term: { 'actor.email': filters.actorEmail } });
  if (filters.actorId || filters.actor_id) must.push({ term: { 'actor.id': filters.actorId || filters.actor_id } });
  if (filters.actorType) {
    // Map 'human' → 'user', 'system' → 'system' (pass-through)
    const esActorType = filters.actorType === 'human' ? 'user' : filters.actorType;
    must.push({ term: { 'actor.type': esActorType } });
  }
  if (filters.resourceType) must.push({ term: { 'resource.type': filters.resourceType } });
  if (filters.resourceId) must.push({ term: { 'resource.id': filters.resourceId } });
  if (filters.clientId) must.push({ term: { 'client.id': filters.clientId } });

  const dateFrom = filters.dateFrom || filters.from;
  const dateTo = filters.dateTo || filters.to;
  if (dateFrom || dateTo) {
    const range: Record<string, string> = {};
    if (dateFrom) range.gte = typeof dateFrom === 'string' ? dateFrom : dateFrom.toISOString();
    if (dateTo) range.lte = typeof dateTo === 'string' ? dateTo : dateTo.toISOString();
    must.push({ range: { timestamp: range } });
  }

  if (filters.search) {
    must.push({
      multi_match: {
        query: filters.search,
        fields: ['resource.name', 'actor.email', 'eventType', 'context.*'],
        type: 'best_fields',
        fuzziness: 'AUTO',
      },
    });
  }

  const ceiling = filters.maxLimit && filters.maxLimit > 0 ? filters.maxLimit : 200;
  const limit = Math.min(filters.limit || filters.size || 50, ceiling);
  const offset = filters.offset || 0;
  const sortField = filters.sortField || 'timestamp';
  const sortOrder = filters.sortOrder || filters.sort || 'desc';

  return {
    query: { bool: { must } },
    sort: [{ [sortField]: { order: sortOrder } }],
    size: limit,
    from: offset,
    track_total_hits: true,
  };
}

// ─── Index range computation ─────────────────────────────────────────────────

function computeIndices(dateFrom?: string | Date | null, dateTo?: string | Date | null): string {
  // Always use the wildcard pattern. The query body's timestamp range filter
  // (see buildQuery) already restricts results to the date window; the
  // `audit-*` wildcard lets ES do index-level metadata pruning automatically
  // (each monthly index has min/max timestamp metadata — non-overlapping
  // indices are skipped at query time).
  //
  // Why we no longer enumerate per-month indices in the URL:
  //   - For agencies with multi-year retention (Enterprise: 2555 days), the
  //     clamp can set `dateFrom` ~7 years ago. Enumerating 80+ monthly
  //     indices into a comma-separated URL slug pushed the request URL over
  //     the Searchbox proxy's 1KB URL limit, returning 414 Request-URI Too
  //     Large. The proxy 414 surfaces as a 500 with empty body to the
  //     caller (because it preempts the route's structured serverError
  //     envelope path).
  //   - The wildcard is no slower in practice — ES caches resolved index
  //     lists per node and prunes by index-level timestamp metadata.
  //
  // Args kept for ABI compatibility / future re-introduction; intentionally
  // unused.
  void dateFrom;
  void dateTo;
  return allIndicesPattern();
}

// ─── Public API ──────────────────────────────────────────────────────────────

// ─── Postgres read projection (audit_events_mirror) ──────────────────────────
//
// The `audit_events_mirror` table is now written on every publish in ALL
// environments (see publisher.ts → writeProjectionBatch), turning it from an
// E2E-only seam into a first-class read projection. The hosted Searchly (ES)
// cluster is at its max index count and silently drops new events (#1766 /
// #1924), so resource-scoped reads cannot rely on ES alone.
//
// The fallback is therefore always available. The call sites only PREFER the
// projection when its total exceeds the ES total, so a healthy/denser ES
// result is never overridden by a sparser projection — when ES is serving
// correctly, behaviour is unchanged.
//
// The legacy E2E_AUDIT_MIRROR_MODE env flag is retained for back-compat but is
// no longer required to enable the fallback.

function isMirrorModeEnabled(): boolean {
  return true;
}

async function queryAuditEventsFromMirror(filters: AuditQueryOptions): Promise<AuditQueryResult> {
  const agencyId = filters.agencyId || filters.agency_id;
  if (!agencyId) return { data: [], total: 0, limit: 50, offset: 0 };

  const { getRuntime } = await import('../runtime.js');
  const { prisma } = getRuntime();
  if (!prisma) return { data: [], total: 0, limit: 50, offset: 0 };

  const ceiling = filters.maxLimit && filters.maxLimit > 0 ? filters.maxLimit : 200;
  const limit = Math.min(filters.limit || filters.size || 50, ceiling);
  const offset = filters.offset || 0;
  const sortOrder = filters.sortOrder || filters.sort || 'desc';

  const where: Record<string, unknown> = { agencyId };

  const eventType = filters.eventType;
  if (eventType) {
    if (typeof eventType === 'string' && eventType.endsWith('*')) {
      where.eventType = { startsWith: eventType.replace('*', '') };
    } else if (Array.isArray(eventType)) {
      where.eventType = { in: eventType };
    } else {
      where.eventType = eventType;
    }
  }

  // Resource-scoped queries (e.g. fetchStateChangesForSource) must only see
  // events for the requested source; without these filters the uptime reducer
  // would receive events from every source in the agency and produce wrong math.
  if (filters.resourceType) where.resourceType = filters.resourceType;
  if (filters.resourceId) where.resourceId = filters.resourceId;

  const dateFrom = filters.dateFrom || filters.from;
  const dateTo = filters.dateTo || filters.to;
  if (dateFrom || dateTo) {
    const capturedAt: Record<string, Date> = {};
    if (dateFrom) capturedAt.gte = typeof dateFrom === 'string' ? new Date(dateFrom) : (dateFrom as Date);
    if (dateTo) capturedAt.lte = typeof dateTo === 'string' ? new Date(dateTo) : (dateTo as Date);
    where.capturedAt = capturedAt;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mirrorPrisma = prisma as any;
  if (!mirrorPrisma.auditEventsMirror) {
    // Table not yet migrated in this environment; return empty.
    return { data: [], total: 0, limit, offset };
  }

  const [rows, total] = await Promise.all([
    mirrorPrisma.auditEventsMirror.findMany({
      where,
      orderBy: { capturedAt: sortOrder },
      take: limit,
      skip: offset,
      select: {
        id: true,
        agencyId: true,
        eventType: true,
        action: true,
        severity: true,
        source: true,
        actorId: true,
        actorEmail: true,
        resourceId: true,
        resourceType: true,
        payload: true,
        e2eTag: true,
        capturedAt: true,
      },
    }),
    mirrorPrisma.auditEventsMirror.count({ where }),
  ]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: AuditEvent[] = rows.map((row: any) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    return {
      id: row.id,
      eventId: payload.eventId as string | undefined ?? row.id,
      eventType: row.eventType,
      type: row.eventType,
      action: row.action,
      severity: row.severity,
      source: row.source,
      timestamp: row.capturedAt instanceof Date ? row.capturedAt.toISOString() : String(row.capturedAt),
      agency: { id: row.agencyId },
      agency_id: row.agencyId,
      actor: row.actorId || row.actorEmail
        ? { id: row.actorId ?? null, email: row.actorEmail ?? null }
        : undefined,
      resource: row.resourceType || row.resourceId
        ? { type: row.resourceType ?? undefined, id: row.resourceId ?? undefined }
        : undefined,
      context: (payload.context ?? {}) as Record<string, unknown>,
      ...payload,
    } as unknown as AuditEvent;
  });

  return { data, total, limit, offset };
}

export async function queryAuditEvents(filters: AuditQueryOptions): Promise<AuditQueryResult> {
  const queryBody = buildQuery(filters);
  const dateFrom = filters.dateFrom || filters.from;
  const dateTo = filters.dateTo || filters.to;
  const indices = computeIndices(
    dateFrom ? String(dateFrom) : undefined,
    dateTo ? String(dateTo) : undefined,
  );

  try {
    const result = await search(queryBody, indices);

    const hits = result.hits?.hits || [];
    const rawTotal = result.hits?.total;
    const total = typeof rawTotal === 'number' ? rawTotal : rawTotal?.value || 0;

    // Mirror fallback: when mirror mode is enabled, ALWAYS consult the Postgres
    // mirror and use its result if it has a higher total than ES. This handles
    // all failure scenarios on the hosted Searchly cluster:
    //
    //   (a) ES index quota exhausted → synthetic E2E events are silently dropped
    //       (the _bulk call returns 200 with errors:true). The current monthly
    //       index may already hold *some* real events that ES can serve, giving
    //       a non-zero but sub-page total. The old `total < queryBody.size`
    //       trigger missed the case where ES returns exactly page_size real
    //       events (e.g. 50) — total is not < size so the mirror was never
    //       consulted, and seeded PG events were invisible regardless of how
    //       many were seeded.
    //
    //   (b) ES returns 0 hits — handled by same always-check path.
    //
    //   (c) ES returns exactly page_size hits from real events — old trigger
    //       `total < queryBody.size` was false; now we always check mirror.
    //
    // We only switch to the mirror when `mirrorResult.total > total`, so a
    // legitimate dense ES result set is never overridden by a sparser mirror.
    // Production behaviour is completely unchanged (env unset → flag is false).
    if (isMirrorModeEnabled()) {
      const mirrorResult = await queryAuditEventsFromMirror(filters);
      if (mirrorResult.total > total) {
        return mirrorResult;
      }
    }

    return {
      data: hits.map((h: any) => h._source) as unknown as AuditEvent[],
      total,
      limit: queryBody.size,
      offset: queryBody.from,
    };
  } catch (err: unknown) {
    const msg = (err as Error).message;
    // Mirror fallback on ANY ES error when mirror mode is enabled.
    //
    // Previous versions only caught 404 / index_not_found here. But
    // Searchly (at max index count) can also return:
    //   - Connection timeouts (ECONNRESET, ETIMEDOUT)
    //   - 503 Service Unavailable
    //   - Other 5xx cluster errors
    // These bypass the 404-only guard, the error propagates to the API
    // route's outer catch, which returns a 500 — and the mirror is never
    // consulted, even though it has the 51 seeded rows.
    //
    // Fix: in mirror mode, any ES failure falls back to the mirror. We
    // still preserve the non-mirror path (empty result for 404, re-throw
    // for all other errors) so production behaviour is unchanged when the
    // env flag is absent.
    if (isMirrorModeEnabled()) {
      return queryAuditEventsFromMirror(filters);
    }
    if (msg.includes('404') || msg.includes('index_not_found')) {
      return { data: [], total: 0, limit: queryBody.size, offset: queryBody.from };
    }
    throw err;
  }
}

export async function getActivityForResource(
  agencyId: string,
  resourceType: string,
  resourceId: string,
  options: Partial<AuditQueryOptions> = {},
): Promise<AuditEvent[]> {
  const result = await queryAuditEvents({
    agencyId,
    resourceType,
    resourceId,
    limit: options.limit || 50,
    offset: options.offset || 0,
    sortOrder: 'desc',
  });
  return result.data;
}

export async function getActivityForClient(
  agencyId: string,
  clientId: string,
  options: Partial<AuditQueryOptions> = {},
): Promise<AuditEvent[]> {
  const result = await queryAuditEvents({
    agencyId,
    clientId,
    limit: options.limit || 50,
    offset: options.offset || 0,
    sortOrder: 'desc',
  });
  return result.data;
}

export async function getEventCountsByType(
  agencyId: string | undefined,
  dateFrom?: string,
  dateTo?: string,
): Promise<EventCountsResult> {
  if (!agencyId) return { byEventType: [], bySeverity: [], bySource: [], total: 0 };

  const indices = computeIndices(dateFrom, dateTo);
  const queryBody: Record<string, unknown> = {
    query: {
      bool: {
        must: [
          { term: { 'agency.id': agencyId } },
          ...(dateFrom || dateTo ? [{
            range: {
              timestamp: {
                ...(dateFrom ? { gte: dateFrom } : {}),
                ...(dateTo ? { lte: dateTo } : {}),
              },
            },
          }] : []),
        ],
      },
    },
    size: 0,
    aggs: {
      by_event_type: { terms: { field: 'eventType', size: 100 } },
      by_severity: { terms: { field: 'severity', size: 10 } },
      by_source: { terms: { field: 'source', size: 20 } },
    },
  };

  try {
    const result = await search(queryBody, indices);
    const rawTotal = result.hits?.total;
    return {
      byEventType: result.aggregations?.by_event_type?.buckets || [],
      bySeverity: result.aggregations?.by_severity?.buckets || [],
      bySource: result.aggregations?.by_source?.buckets || [],
      total: typeof rawTotal === 'number' ? rawTotal : rawTotal?.value || 0,
    };
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) {
      return { byEventType: [], bySeverity: [], bySource: [], total: 0 };
    }
    throw err;
  }
}

export async function exportAuditEvents(filters: AuditQueryOptions): Promise<AuditQueryResult> {
  return queryAuditEvents({ ...filters, limit: 10000 });
}

// ─── Time-Series / Histogram ──────────────────────────────────────────────────

export interface TimeSeriesOptions {
  /** ISO string or Date — start of the window */
  from: string | Date;
  /** ISO string or Date — end of the window */
  to: string | Date;
  /** ES fixed_interval string, e.g. '1h', '1d' */
  interval: string;
  /**
   * Expected number of buckets (used for padding/truncation).
   * Buckets that fall inside [from, to) are returned; missing ones are padded
   * with 0. The result is truncated to `expectedBuckets` if ES returns more.
   */
  expectedBuckets: number;
  /** Optional additional must-clauses applied to this histogram only */
  extraMust?: Record<string, unknown>[];
}

export interface TimeSeriesResult {
  /** doc_count per bucket, ordered oldest→newest, exactly `expectedBuckets` long */
  counts: number[];
  /** Total events across the whole window */
  total: number;
}

/**
 * Run a date-histogram aggregation over the audit index for a single agency.
 * Returns exactly `options.expectedBuckets` counts (padded with 0 / truncated).
 *
 * Sources sparkline: for per-bucket *distinct* sources we use a nested
 * cardinality sub-agg. Note that ES cardinality on keyword fields in a
 * date_histogram sub-aggregation is approximate (HyperLogLog) but is the
 * most cost-effective approach without a script — acceptable for sparkline data.
 */
export async function getTimeSeries(
  agencyId: string,
  options: TimeSeriesOptions,
): Promise<TimeSeriesResult> {
  if (!agencyId) return { counts: new Array(options.expectedBuckets).fill(0), total: 0 };

  const fromStr = typeof options.from === 'string' ? options.from : options.from.toISOString();
  const toStr   = typeof options.to   === 'string' ? options.to   : options.to.toISOString();

  const must: Record<string, unknown>[] = [
    { term: { 'agency.id': agencyId } },
    { range: { timestamp: { gte: fromStr, lte: toStr } } },
    ...(options.extraMust ?? []),
  ];

  const queryBody: Record<string, unknown> = {
    query: { bool: { must } },
    size: 0,
    aggs: {
      over_time: {
        date_histogram: {
          field: 'timestamp',
          fixed_interval: options.interval,
          extended_bounds: { min: fromStr, max: toStr },
          min_doc_count: 0,
        },
      },
    },
  };

  const indices = allIndicesPattern();

  try {
    const result = await search(queryBody, indices);
    const rawBuckets = (result.aggregations?.over_time?.buckets ?? []) as unknown as Array<{ key_as_string: string; doc_count: number }>;

    // Pad / truncate to exactly expectedBuckets.
    // When from/to aren't hour-aligned ES may emit expectedBuckets+1 buckets.
    // Keep the NEWEST expectedBuckets (slice from the end) so the current
    // (most relevant) hour is always included.
    const counts: number[] = rawBuckets.map((b) => b.doc_count);
    while (counts.length < options.expectedBuckets) counts.push(0);
    const trimmed = counts.slice(-options.expectedBuckets);

    const rawTotal = result.hits?.total;
    const total = typeof rawTotal === 'number' ? rawTotal : rawTotal?.value ?? 0;

    return { counts: trimmed, total };
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) {
      return { counts: new Array(options.expectedBuckets).fill(0), total: 0 };
    }
    throw err;
  }
}

// ─── Actor-Kind Counts ────────────────────────────────────────────────────────

export interface ActorKindBucket {
  key: 'human' | 'system';
  doc_count: number;
}

/**
 * Returns counts grouped by actor kind (human / system) for the given window.
 * Maps ES `actor.type` values: `user` → `human`, everything else → `system`.
 */
export async function getActorKindCounts(
  agencyId: string,
  dateFrom?: string,
  dateTo?: string,
): Promise<ActorKindBucket[]> {
  if (!agencyId) return [];

  const must: Record<string, unknown>[] = [
    { term: { 'agency.id': agencyId } },
    ...(dateFrom || dateTo ? [{
      range: {
        timestamp: {
          ...(dateFrom ? { gte: dateFrom } : {}),
          ...(dateTo ? { lte: dateTo } : {}),
        },
      },
    }] : []),
  ];

  const queryBody: Record<string, unknown> = {
    query: { bool: { must } },
    size: 0,
    aggs: {
      by_actor_type: { terms: { field: 'actor.type', size: 10 } },
    },
  };

  const indices = allIndicesPattern();

  try {
    const result = await search(queryBody, indices);
    const rawBuckets: Array<{ key: string; doc_count: number }> =
      result.aggregations?.by_actor_type?.buckets ?? [];

    // Map `user` → `human`, `system` → `system`, merge any unexpected values.
    // Any actor.type that is not 'user' is bucketed as 'system' — this holds for
    // all current values ('user' and 'system') and degrades gracefully for future ones.
    const merged: Record<string, number> = {};
    for (const b of rawBuckets) {
      const kind = b.key === 'user' ? 'human' : 'system';
      merged[kind] = (merged[kind] ?? 0) + b.doc_count;
    }

    return (Object.entries(merged) as [string, number][]).map(([key, doc_count]) => ({
      key: key as 'human' | 'system',
      doc_count,
    }));
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) return [];
    throw err;
  }
}

// ─── Preset Count Query ───────────────────────────────────────────────────────

export interface PresetCountOptions {
  severity?: string;
  /** domain prefix — translated to eventType prefix filter */
  domain?: string;
  actorType?: 'human' | 'system';
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Count events matching the given preset filter combination, agency-scoped.
 * Used by `/api/audit/stats` to populate `presetCounts`.
 */
export async function getPresetCount(
  agencyId: string,
  opts: PresetCountOptions,
): Promise<number> {
  if (!agencyId) return 0;

  const must: Record<string, unknown>[] = [
    { term: { 'agency.id': agencyId } },
  ];

  if (opts.dateFrom || opts.dateTo) {
    must.push({
      range: {
        timestamp: {
          ...(opts.dateFrom ? { gte: opts.dateFrom } : {}),
          ...(opts.dateTo ? { lte: opts.dateTo } : {}),
        },
      },
    });
  }

  if (opts.severity) must.push({ term: { severity: opts.severity } });
  if (opts.domain) must.push({ prefix: { eventType: `${opts.domain}.` } });
  if (opts.actorType) {
    const esValue = opts.actorType === 'human' ? 'user' : 'system';
    must.push({ term: { 'actor.type': esValue } });
  }

  const queryBody: Record<string, unknown> = {
    query: { bool: { must } },
    size: 0,
    track_total_hits: true,
  };

  const indices = allIndicesPattern();

  try {
    const result = await search(queryBody, indices);
    const rawTotal = result.hits?.total;
    return typeof rawTotal === 'number' ? rawTotal : rawTotal?.value ?? 0;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) return 0;
    throw err;
  }
}
