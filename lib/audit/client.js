/**
 * Elasticsearch client for the Audit & Compliance engine.
 *
 * Uses the SEARCHBOX_URL env var provisioned by the SearchBox Heroku add-on.
 * Provides low-level index management and document operations.
 */

/**
 * Parse SEARCHBOX_URL which may contain credentials (user:pass@host).
 * Node 20's native fetch doesn't support credentials in URLs,
 * so we extract them into a Basic auth header.
 */
let _esBase = null;
let _esAuth = null;

function parseEsUrl() {
  if (_esBase !== null) return;
  const raw = process.env.SEARCHBOX_URL;
  if (!raw) { _esBase = ''; return; }

  try {
    const u = new URL(raw);
    if (u.username) {
      _esAuth = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');
      _esBase = `${u.protocol}//${u.host}`;
    } else {
      _esBase = raw.replace(/\/$/, '');
    }
  } catch {
    _esBase = raw.replace(/\/$/, '');
  }
}

const ES_URL = () => { parseEsUrl(); return _esBase; };
const ES_AUTH = () => { parseEsUrl(); return _esAuth; };

// ─── Index Management ────────────────────────────────────────────────────────

/**
 * Current index name based on year-month (shared time-based indices).
 * Pattern: audit-YYYY.MM
 */
export function currentIndexName() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `audit-${y}.${m}`;
}

/**
 * Index name for a specific date.
 */
export function indexNameForDate(date) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `audit-${y}.${m}`;
}

/**
 * Wildcard pattern matching all audit indices.
 */
export function allIndicesPattern() {
  return 'audit-*';
}

// ─── Low-Level Fetch ─────────────────────────────────────────────────────────

async function esFetch(path, options = {}) {
  const base = ES_URL();
  if (!base) throw new Error('SEARCHBOX_URL not configured');

  const auth = ES_AUTH();
  const url = `${base}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
      ...options.headers,
    },
  });
  return res;
}

// ─── Index Template ──────────────────────────────────────────────────────────

const INDEX_TEMPLATE = {
  index_patterns: ['audit-*'],
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0, // Starter tier — no replicas
    'index.mapping.total_fields.limit': 200,
  },
  mappings: {
    properties: {
      // Core
      eventId:    { type: 'keyword' },
      timestamp:  { type: 'date' },
      eventType:  { type: 'keyword' },
      source:     { type: 'keyword' },
      severity:   { type: 'keyword' },

      // Actor
      'actor.id':    { type: 'keyword' },
      'actor.email': { type: 'keyword' },
      'actor.type':  { type: 'keyword' },
      'actor.ip':    { type: 'ip', ignore_malformed: true },

      // Tenant
      'agency.id':   { type: 'keyword' },
      'agency.slug': { type: 'keyword' },
      'client.id':   { type: 'keyword' },
      'client.name': { type: 'keyword' },

      // Resource
      'resource.type': { type: 'keyword' },
      'resource.id':   { type: 'keyword' },
      'resource.name': { type: 'text', fields: { keyword: { type: 'keyword' } } },

      // Context (flexible — ES auto-maps nested fields)
      context: { type: 'object', enabled: true },

      // Compliance
      eventHash: { type: 'keyword' },
      prevHash:  { type: 'keyword' },
      retentionDays: { type: 'integer' },
    },
  },
};

/**
 * Ensure the index template exists. Idempotent — call on startup.
 */
export async function ensureIndexTemplate() {
  try {
    const res = await esFetch('/_template/audit-template', {
      method: 'PUT',
      body: JSON.stringify(INDEX_TEMPLATE),
    });
    if (!res.ok) {
      const text = await res.text();
      console.error('[Audit ES] Failed to create index template:', res.status, text);
    } else {
      console.log('[Audit ES] Index template ensured');
    }
  } catch (err) {
    console.error('[Audit ES] Template setup error:', err.message);
  }
}

/**
 * Ensure the current month's index exists. Idempotent.
 */
export async function ensureCurrentIndex() {
  const idx = currentIndexName();
  try {
    const head = await esFetch(`/${idx}`, { method: 'HEAD' });
    if (head.status === 404) {
      const create = await esFetch(`/${idx}`, { method: 'PUT' });
      if (!create.ok) {
        const text = await create.text();
        console.error('[Audit ES] Failed to create index', idx, ':', text);
      } else {
        console.log('[Audit ES] Created index:', idx);
      }
    }
  } catch (err) {
    console.error('[Audit ES] Index check error:', err.message);
  }
}

// ─── Document Operations ─────────────────────────────────────────────────────

/**
 * Index a single document.
 */
export async function indexDocument(doc) {
  const idx = currentIndexName();
  const res = await esFetch(`/${idx}/_doc/${doc.eventId}`, {
    method: 'PUT',
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES index failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Bulk index multiple documents.
 * Uses the ES _bulk API for efficient batch writes.
 */
export async function bulkIndex(docs) {
  if (!docs.length) return { errors: false, items: [] };

  const lines = [];
  for (const doc of docs) {
    const idx = indexNameForDate(doc.timestamp);
    lines.push(JSON.stringify({ index: { _index: idx, _id: doc.eventId } }));
    lines.push(JSON.stringify(doc));
  }
  const body = lines.join('\n') + '\n';

  const res = await esFetch('/_bulk', {
    method: 'POST',
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES bulk failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Search documents with an ES query DSL body.
 */
export async function search(queryBody, indices) {
  const idx = indices || allIndicesPattern();
  const res = await esFetch(`/${idx}/_search`, {
    method: 'POST',
    body: JSON.stringify(queryBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES search failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Delete by query — used for retention cleanup.
 */
export async function deleteByQuery(queryBody, indices) {
  const idx = indices || allIndicesPattern();
  const res = await esFetch(`/${idx}/_delete_by_query`, {
    method: 'POST',
    body: JSON.stringify(queryBody),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES delete_by_query failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * Get cluster health — for operational monitoring.
 */
export async function clusterHealth() {
  const res = await esFetch('/_cluster/health');
  if (!res.ok) return null;
  return res.json();
}

/**
 * Check if ES is reachable.
 */
export async function ping() {
  try {
    const res = await esFetch('/');
    return res.ok;
  } catch {
    return false;
  }
}
