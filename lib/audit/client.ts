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

// ─── Context Sanitization (ES dynamic-mapping conflict guard) ─────────────────

/**
 * `context` is a free-form, per-`eventType` payload. Different events put
 * different *types* at the same path — e.g. `context.skipped` is a scalar (`0`)
 * in `jml_process_lifecycle` / `maintain_drift_remediations` but an object in
 * other events. Elasticsearch dynamically maps each `context.<field>` path on
 * first sight and then rejects any later document whose path carries a
 * different type:
 *
 *   mapper_parsing_exception: object mapping for [context.skipped] tried to
 *   parse field [skipped] as object, but found a concrete value
 *
 * which fails the whole `audit_index_es` job — Bull retries forever and ES
 * never catches up (observed in prod 2026-06-09).
 *
 * Reindexing the already-poisoned monthly index is impossible in place (you
 * cannot change a field's type) and risky on the index-count-capped Searchly
 * plan (see docs/architecture/audit-postgres-mirror.md — dropping/recreating
 * could fail to recreate). So instead we never send a *structured* `context`
 * to ES at all: the whole blob is serialised into a single scalar `contextJson`
 * string, which can never type-flip regardless of what any event puts inside
 * `context`. Readers call `rehydrateContext` to restore the original shape, so
 * `_source` consumers are unaffected. Postgres (`AuditEvent` +
 * `audit_events_mirror`) remains the source of truth; ES is only a search
 * mirror, and `_source` already diverges from the canonical MinIO body (the
 * indexer adds seq/prevHash/etc.), so this reshaping does not affect the hash
 * chain (integrity is verified via `bodySha256` over the MinIO body).
 */
export function sanitizeContextForEs<T extends Record<string, unknown>>(doc: T): T {
  if (!doc || typeof doc !== 'object' || !('context' in doc)) return doc;
  const { context, ...rest } = doc as Record<string, unknown>;
  // null/undefined context carries no nested paths — just drop it.
  if (context === null || context === undefined) {
    return rest as T;
  }
  return { ...rest, contextJson: JSON.stringify(context) } as unknown as T;
}

/**
 * Inverse of {@link sanitizeContextForEs} for the ES read path. If a `_source`
 * carries the serialised `contextJson` field, parse it back into `context` so
 * downstream consumers see the original structured shape. Tolerates:
 *   - legacy docs that still carry a structured `context` (pre-fix indices),
 *   - malformed JSON (falls back to an empty object rather than throwing).
 */
export function rehydrateContext<T extends Record<string, unknown>>(source: T): T {
  if (!source || typeof source !== 'object') return source;
  if (typeof (source as Record<string, unknown>).contextJson !== 'string') return source;
  const { contextJson, ...rest } = source as Record<string, unknown>;
  // A structured context shouldn't co-exist with contextJson, but if a legacy
  // doc somehow has both, prefer the structured one and just drop contextJson.
  if ('context' in rest && rest.context !== undefined) {
    return rest as T;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(contextJson as string);
  } catch {
    parsed = {};
  }
  return { ...rest, context: parsed } as unknown as T;
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
      // `context` is a free-form payload whose shape varies per `eventType`
      // (`context.skipped` is a scalar in jml_process_lifecycle but an object
      // elsewhere, gateway events nest objects, etc.). With dynamic mapping ES
      // auto-infers a type for each `context.<field>` path on first sight and
      // rejects subsequent docs whose path has a different type — see prod
      // failures of
      //   "object mapping for [context.skipped] tried to parse field
      //    [skipped] as object, but found a concrete value".
      //
      // The indexer no longer sends a *structured* `context` at all: it is
      // serialised to a single scalar `contextJson` string before indexing
      // (see sanitizeContextForEs) and rehydrated on read (rehydrateContext in
      // query.ts). `contextJson` is one `text` field that can never type-flip,
      // and it stays searchable (the `search` filter targets it). We keep the
      // legacy `context` object mapping disabled so that any straggler docs
      // carrying a structured `context` (e.g. on a pre-fix monthly index) are
      // still stored in `_source` without dynamic sub-field mapping.
      context: { type: 'object', enabled: false },
      contextJson: { type: 'text', fields: { keyword: { type: 'keyword', ignore_above: 8191 } } },
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

/** True only for a 404 whose body is an Elasticsearch index_not_found_exception. */
export function isIndexNotFound(status: number, bodyText: string): boolean {
  return status === 404 && bodyText.includes('index_not_found_exception');
}

/**
 * Idempotently create `indexName`. Treats an already-existing index as success
 * (concurrent indexers racing to create the same monthly index). Best-effort:
 * any other failure is logged and swallowed — the caller's retry will re-surface
 * a genuine problem as another 404 and re-queue the job.
 */
export async function ensureIndexExists(indexName: string): Promise<void> {
  try {
    const res = await esFetch(`/${indexName}`, { method: 'PUT' });
    if (res.ok) {
      console.log('[Audit ES] Created index:', indexName);
      return;
    }
    const text = await res.text();
    if (text.includes('resource_already_exists_exception')) return; // already there — fine
    console.error('[Audit ES] Failed to create index', indexName, ':', text);
  } catch (err: unknown) {
    console.error('[Audit ES] Index create error:', (err as Error).message);
  }
}

export async function ensureCurrentIndex(): Promise<void> {
  await ensureIndexExists(currentIndexName());
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
  // Serialise `context` → `contextJson` so ES never sees a type-flipping
  // `context.<field>` path (see sanitizeContextForEs).
  const safeDoc = sanitizeContextForEs(doc as unknown as Record<string, unknown>);
  const refreshQs = opts?.refresh ? `?refresh=${opts.refresh}` : '';
  const res = await esFetch(`/${idx}/_doc/${doc.eventId}${refreshQs}`, {
    method: 'PUT',
    body: JSON.stringify(safeDoc),
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
    const safeDoc = sanitizeContextForEs(doc as unknown as Record<string, unknown>);
    lines.push(JSON.stringify({ index: { _index: idx, _id: doc.eventId } }));
    lines.push(JSON.stringify(safeDoc));
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
