/**
 * Audit Query Service
 *
 * Wraps Elasticsearch queries for the API layer.
 * ALWAYS injects agency.id filter for tenant isolation.
 * Powers both the Audit & Reports page and Activity tabs.
 */

import { search, allIndicesPattern, indexNameForDate } from './client.js';

// ─── Query Builder ───────────────────────────────────────────────────────────

/**
 * Build an ES query for audit events.
 *
 * @param {Object} filters
 * @param {string} filters.agencyId       - REQUIRED. Tenant isolation.
 * @param {string} [filters.eventType]    - Exact match or prefix (e.g. 'pam.*')
 * @param {string} [filters.source]       - Event source filter
 * @param {string} [filters.severity]     - Severity filter
 * @param {string} [filters.actorEmail]   - Actor email filter
 * @param {string} [filters.actorId]      - Actor ID filter
 * @param {string} [filters.resourceType] - Resource type filter
 * @param {string} [filters.resourceId]   - Resource ID filter
 * @param {string} [filters.clientId]     - Client scope filter
 * @param {string} [filters.dateFrom]     - Start date (ISO)
 * @param {string} [filters.dateTo]       - End date (ISO)
 * @param {string} [filters.search]       - Full-text search across resource.name + context
 * @param {number} [filters.limit]        - Page size (default 50)
 * @param {number} [filters.offset]       - Offset for pagination (default 0)
 * @param {string} [filters.sortField]    - Sort field (default 'timestamp')
 * @param {string} [filters.sortOrder]    - 'asc' or 'desc' (default 'desc')
 */
function buildQuery(filters) {
  if (!filters.agencyId) throw new Error('agencyId is required for audit queries');

  const must = [
    { term: { 'agency.id': filters.agencyId } },
  ];

  if (filters.eventType) {
    if (filters.eventType.endsWith('*')) {
      // Prefix match: 'pam.*' → matches 'pam.session.checkout', etc.
      must.push({ prefix: { eventType: filters.eventType.replace('*', '') } });
    } else if (Array.isArray(filters.eventType)) {
      must.push({ terms: { eventType: filters.eventType } });
    } else {
      must.push({ term: { eventType: filters.eventType } });
    }
  }

  if (filters.source) must.push({ term: { source: filters.source } });
  if (filters.severity) must.push({ term: { severity: filters.severity } });
  if (filters.actorEmail) must.push({ term: { 'actor.email': filters.actorEmail } });
  if (filters.actorId) must.push({ term: { 'actor.id': filters.actorId } });
  if (filters.resourceType) must.push({ term: { 'resource.type': filters.resourceType } });
  if (filters.resourceId) must.push({ term: { 'resource.id': filters.resourceId } });
  if (filters.clientId) must.push({ term: { 'client.id': filters.clientId } });

  // Date range
  if (filters.dateFrom || filters.dateTo) {
    const range = {};
    if (filters.dateFrom) range.gte = filters.dateFrom;
    if (filters.dateTo) range.lte = filters.dateTo;
    must.push({ range: { timestamp: range } });
  }

  // Full-text search
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

  const limit = Math.min(filters.limit || 50, 200);
  const offset = filters.offset || 0;
  const sortField = filters.sortField || 'timestamp';
  const sortOrder = filters.sortOrder || 'desc';

  return {
    query: { bool: { must } },
    sort: [{ [sortField]: { order: sortOrder } }],
    size: limit,
    from: offset,
    track_total_hits: true,
  };
}

// ─── Compute index range for date filters ────────────────────────────────────

function computeIndices(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return allIndicesPattern();

  const start = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 365 * 86400000);
  const end = dateTo ? new Date(dateTo) : new Date();

  const indices = new Set();
  const cursor = new Date(start);
  while (cursor <= end) {
    indices.add(indexNameForDate(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  // Always include end month
  indices.add(indexNameForDate(end));

  return [...indices].join(',');
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Query audit events with filters and pagination.
 * Returns { data, total, limit, offset }.
 */
export async function queryAuditEvents(filters) {
  const queryBody = buildQuery(filters);
  const indices = computeIndices(filters.dateFrom, filters.dateTo);

  try {
    const result = await search(queryBody, indices);

    const hits = result.hits?.hits || [];
    const total = result.hits?.total?.value || result.hits?.total || 0;

    return {
      data: hits.map(h => h._source),
      total,
      limit: queryBody.size,
      offset: queryBody.from,
    };
  } catch (err) {
    // If index doesn't exist yet, return empty
    if (err.message.includes('404') || err.message.includes('index_not_found')) {
      return { data: [], total: 0, limit: queryBody.size, offset: queryBody.from };
    }
    throw err;
  }
}

/**
 * Get audit events for a specific resource (powers Activity tabs).
 */
export async function getActivityForResource(agencyId, resourceType, resourceId, options = {}) {
  return queryAuditEvents({
    agencyId,
    resourceType,
    resourceId,
    limit: options.limit || 50,
    offset: options.offset || 0,
    sortOrder: 'desc',
  });
}

/**
 * Get audit events for a specific client (powers client Activity tab).
 */
export async function getActivityForClient(agencyId, clientId, options = {}) {
  return queryAuditEvents({
    agencyId,
    clientId,
    limit: options.limit || 50,
    offset: options.offset || 0,
    sortOrder: 'desc',
  });
}

/**
 * Get aggregated event counts by type (for dashboard widgets).
 */
export async function getEventCountsByType(agencyId, dateFrom, dateTo) {
  const indices = computeIndices(dateFrom, dateTo);
  const queryBody = {
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
      by_event_type: {
        terms: { field: 'eventType', size: 100 },
      },
      by_severity: {
        terms: { field: 'severity', size: 10 },
      },
      by_source: {
        terms: { field: 'source', size: 20 },
      },
    },
  };

  try {
    const result = await search(queryBody, indices);
    return {
      byEventType: result.aggregations?.by_event_type?.buckets || [],
      bySeverity: result.aggregations?.by_severity?.buckets || [],
      bySource: result.aggregations?.by_source?.buckets || [],
      total: result.hits?.total?.value || result.hits?.total || 0,
    };
  } catch (err) {
    if (err.message.includes('404') || err.message.includes('index_not_found')) {
      return { byEventType: [], bySeverity: [], bySource: [], total: 0 };
    }
    throw err;
  }
}

/**
 * Export audit events (no pagination limit, streams all matching).
 * For compliance report generation.
 */
export async function exportAuditEvents(filters) {
  const allFilters = { ...filters, limit: 10000 }; // ES max window
  return queryAuditEvents(allFilters);
}
