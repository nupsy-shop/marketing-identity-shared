/**
 * Audit Query Service
 *
 * Wraps Elasticsearch queries for the API layer.
 * ALWAYS injects agency.id filter for tenant isolation.
 * Powers both the Audit & Reports page and Activity tabs.
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

  const limit = Math.min(filters.limit || filters.size || 50, 200);
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
  if (!dateFrom && !dateTo) return allIndicesPattern();

  const start = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 365 * 86400000);
  const end = dateTo ? new Date(dateTo) : new Date();

  const indices = new Set<string>();
  const cursor = new Date(start);
  while (cursor <= end) {
    indices.add(indexNameForDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  indices.add(indexNameForDate(end));

  return [...indices].join(',');
}

// ─── Public API ──────────────────────────────────────────────────────────────

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

    return {
      data: hits.map(h => h._source) as unknown as AuditEvent[],
      total,
      limit: queryBody.size,
      offset: queryBody.from,
    };
  } catch (err: unknown) {
    const msg = (err as Error).message;
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
