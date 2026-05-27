/**
 * Elasticsearch client for the Audit & Compliance engine.
 *
 * Uses the SEARCHBOX_URL env var provisioned by the SearchBox Heroku add-on.
 * Provides low-level index management and document operations.
 *
 * E2E ES override primitive
 * ─────────────────────────
 * When `getRuntime().resolveProviderOverride` is registered AND a matching
 * `provider_response_overrides` row exists for the calling agency with
 * `provider='elasticsearch'`, the `search()` function short-circuits the
 * real ES network call and returns the stubbed response. This mechanism is
 * the E2E "ES network-intercept mock primitive" — same seam as HTTP-provider
 * mocking (provider_response_overrides table), same agency-scoping and TTL.
 *
 * The override is gated on `is_test_tenant` inside `resolveProviderOverride`
 * (resolved from the web-app runtime) so production agencies are never
 * affected.
 *
 * To register a stub from an E2E scenario:
 *   npx tsx tests/support/scripts/seed/set-provider-response.ts \
 *     --agency-id <uuid> --provider elasticsearch \
 *     --endpoint-match <es-path-substring> --status 200 \
 *     --body-json '<es-response-json>' --e2e-tag <tag>
 *
 * Issue: #1640
 */

export interface SearchOptions {
  index?: string;
  body?: Record<string, unknown>;
  size?: number;
  from?: number;
  sort?: Record<string, unknown>[];
  [key: string]: unknown;
}

export interface AuditDocument {
  eventId: string;
  timestamp: string;
  [key: string]: unknown;
}

// ─── Connection Parsing ──────────────────────────────────────────────────────

let _esBase: string | null = null;
let _esAuth: string | null = null;

function parseEsUrl(): void {
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

const ES_URL = (): string => { parseEsUrl(); return _esBase!; };
const ES_AUTH = (): string | null => { parseEsUrl(); return _esAuth; };

// ─── Index Management ────────────────────────────────────────────────────────

export function currentIndexName(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `audit-${y}.${m}`;
}

export function indexNameForDate(date: Date | string): string {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `audit-${y}.${m}`;
}

export function allIndicesPattern(): string {
  return 'audit-*';
}

// ─── Low-Level Fetch ─────────────────────────────────────────────────────────

async function esFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const base = ES_URL();
  if (!base) throw new Error('SEARCHBOX_URL not configured');

  const auth = ES_AUTH();
  const url = `${base}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
      ...(options.headers as Record<string, string> | undefined),
    },
  });
}

// ─── Index Template ──────────────────────────────────────────────────────────

const INDEX_TEMPLATE = {
  index_patterns: ['audit-*'],
  settings: {
    number_of_shards: 1,
    number_of_replicas: 0,
    'index.mapping.total_fields.limit': 200,
  },
  mappings: {
    properties: {
      eventId:    { type: 'keyword' },
      timestamp:  { type: 'date' },
      eventType:  { type: 'keyword' },
      source:     { type: 'keyword' },
      severity:   { type: 'keyword' },
      'actor.id':    { type: 'keyword' },
      'actor.email': { type: 'keyword' },
      'actor.type':  { type: 'keyword' },
      'actor.ip':    { type: 'ip', ignore_malformed: true },
      'agency.id':   { type: 'keyword' },
      'agency.slug': { type: 'keyword' },
      'client.id':   { type: 'keyword' },
      'client.name': { type: 'keyword' },
      'resource.type': { type: 'keyword' },
      'resource.id':   { type: 'keyword' },
      'resource.name': { type: 'text', fields: { keyword: { type: 'keyword' } } },
      // `context` is a free-form payload whose shape varies per
      // `eventType` (drift_maintenance_completed has `skipped: number`,
      // remediation.skipped has `skipped: <missing>`, gateway events
      // have nested objects, etc.). With dynamic mapping enabled and no
      // declared sub-properties, ES auto-infers a type for each path on
      // first sight and rejects subsequent docs whose path has a
      // different type — see prod failures of
      //   "object mapping for [context.skipped] tried to parse field
      //    [skipped] as object, but found a concrete value"
      // We don't query / aggregate on `context.<field>` at the index
      // level — readers always rely on `_source` — so `enabled: false`
      // is the right setting: keep the payload in `_source`, skip
      // indexing of its sub-fields, no dynamic-type conflicts ever.
      // Applies to NEW indices only (templates only fire at index
      // creation); existing monthly indices keep their inferred mapping
      // until the next rollover. To force-heal a current index, drop +
      // recreate it (operational, not in this code change).
      context: { type: 'object', enabled: false },
      eventHash: { type: 'keyword' },
      prevHash:  { type: 'keyword' },
      retentionDays: { type: 'integer' },
    },
  },
};

export async function ensureIndexTemplate(): Promise<void> {
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
  } catch (err: unknown) {
    console.error('[Audit ES] Template setup error:', (err as Error).message);
  }
}

export async function ensureCurrentIndex(): Promise<void> {
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
  } catch (err: unknown) {
    console.error('[Audit ES] Index check error:', (err as Error).message);
  }
}

// ─── Document Operations ─────────────────────────────────────────────────────

export async function indexDocument(
  doc: AuditDocument,
  opts?: { refresh?: 'true' | 'false' | 'wait_for' },
): Promise<Record<string, unknown>> {
  // Use the document's timestamp to pick the right monthly index, not
  // the current month — so backdated events (e2e seeding, replay) land
  // in the correct rollover bucket and don't appear as chain breaks
  // the next time anyone queries that range.
  const idx = doc.timestamp ? indexNameForDate(doc.timestamp) : currentIndexName();
  const refreshQs = opts?.refresh ? `?refresh=${opts.refresh}` : '';
  const res = await esFetch(`/${idx}/_doc/${doc.eventId}${refreshQs}`, {
    method: 'PUT',
    body: JSON.stringify(doc),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES index failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function bulkIndex(docs: AuditDocument[]): Promise<{ errors: boolean; items: Array<Record<string, unknown>> }> {
  if (!docs.length) return { errors: false, items: [] };

  const lines: string[] = [];
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

// ─── E2E ES Override Helper ──────────────────────────────────────────────────

/**
 * Extract the first `agency.id` term value from a bool-must ES query body.
 * Returns undefined when the query body does not carry a term filter (e.g.
 * aggregation-only queries issued without a tenant scope — these fall through
 * to real ES unconditionally).
 */
function extractAgencyId(queryBody: Record<string, unknown>): string | undefined {
  try {
    const must = (queryBody as any)?.query?.bool?.must;
    if (!Array.isArray(must)) return undefined;
    for (const clause of must) {
      const termAgency = clause?.term?.['agency.id'];
      if (typeof termAgency === 'string' && termAgency.length > 0) return termAgency;
    }
  } catch {
    // malformed query body — fail open, real ES handles it
  }
  return undefined;
}

/**
 * Attempt to resolve an E2E ES override for this query.
 *
 * Fail-closed: any error returns null so the real ES call proceeds.
 * This function MUST NOT throw.
 */
async function resolveEsOverride(
  agencyId: string,
  idx: string,
): Promise<{ status: number; body: unknown; delayMs?: number } | null> {
  try {
    const { getRuntime } = await import('../runtime.js');
    let runtime: ReturnType<typeof getRuntime> | null = null;
    try {
      runtime = getRuntime();
    } catch {
      return null; // runtime not initialised — dev/test without setRuntime
    }
    const resolve = runtime?.resolveProviderOverride;
    if (!resolve) return null;

    // Use the index pattern as the "url" key so endpoint_match can target
    // e.g. 'audit-*' or a specific monthly pattern. The provider name is
    // 'elasticsearch' — a new discriminant on the shared table.
    return await resolve(agencyId, 'elasticsearch', idx);
  } catch {
    return null;
  }
}

export async function search(
  queryBody: Record<string, unknown>,
  indices?: string,
): Promise<{
  hits: { total: number | { value: number }; hits: Array<{ _source: Record<string, unknown> }> };
  aggregations?: Record<string, { buckets?: Array<{ key: string; doc_count: number }> }>;
}> {
  const idx = indices || allIndicesPattern();

  // ── E2E ES override intercept ────────────────────────────────────────────
  // Consult the provider_response_overrides table (via runtime.resolveProviderOverride)
  // before making any real ES network call. Only fires for is_test_tenant agencies.
  const agencyId = extractAgencyId(queryBody);
  if (agencyId) {
    const override = await resolveEsOverride(agencyId, idx);
    if (override !== null) {
      // Honour stub delay (simulates slow ES for timeout-branch tests).
      if (override.delayMs && override.delayMs > 0) {
        await new Promise((r) => setTimeout(r, override.delayMs));
      }
      // Return the stubbed ES response body directly.
      return override.body as {
        hits: { total: number | { value: number }; hits: Array<{ _source: Record<string, unknown> }> };
        aggregations?: Record<string, { buckets?: Array<{ key: string; doc_count: number }> }>;
      };
    }
  }
  // ── End ES override intercept ────────────────────────────────────────────
  // `ignore_unavailable=true&allow_no_indices=true` — when callers pass
  // a comma-separated list of specific monthly indices (e.g.
  // `audit-2026.05,audit-2026.04,audit-2026.03`), one or more of the
  // months may not exist yet — a freshly-truncated tenant only has
  // the current month, and a brand-new agency has no prior history at
  // all. Without these flags ES returns 404 (index_not_found_exception)
  // instead of an empty result set, which breaks every chain-walk and
  // every freshly-seeded mutation scenario. The wildcard `audit-*`
  // path doesn't need them (matching zero indices is fine), but it's
  // safe to include unconditionally — a missing wildcard match still
  // returns 200 with zero hits.
  const res = await esFetch(
    `/${idx}/_search?ignore_unavailable=true&allow_no_indices=true`,
    {
      method: 'POST',
      body: JSON.stringify(queryBody),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ES search failed (${res.status}): ${text}`);
  }
  return res.json();
}

export async function deleteByQuery(
  queryBody: Record<string, unknown>,
  indices?: string,
): Promise<Record<string, unknown>> {
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

export async function clusterHealth(): Promise<Record<string, unknown>> {
  const res = await esFetch('/_cluster/health');
  if (!res.ok) return {};
  return res.json();
}

export async function ping(): Promise<boolean> {
  try {
    const res = await esFetch('/');
    return res.ok;
  } catch {
    return false;
  }
}
