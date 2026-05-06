/**
 * Audit hash-chain verifier.
 *
 * Single source of truth for chain integrity. Consumed by:
 *   - GET /api/audit/export/verify-chain (the admin-facing verifier)
 *   - GET /api/audit/export            (CSV/PDF artifact header)
 *   - lib/session-recording/export.ts  (HTML report integrity badge)
 *
 * Invariants enforced here:
 *   - Agency scoped: every ES read injects a term filter on `agency.id`.
 *     Callers MUST wrap ES reads in `withTenantContext(agencyId, …)` at the
 *     API layer; this helper does not bypass that — it is a pure read.
 *   - PII-safe: the returned `BrokenLink[]` contains only `eventId`, `reason`,
 *     and `timestamp`. Raw event bodies, actor emails, resource payloads etc.
 *     are NEVER included in the response. Audit payloads can contain PII.
 *   - Pure read: verification never writes an audit event. Doing so would
 *     create recursion in chain semantics (next verification pass would see
 *     events produced by the prior one).
 *   - Deterministic: given the same ES state and date range, the output is
 *     byte-identical.
 */

import crypto from 'crypto';
import { search, allIndicesPattern, indexNameForDate } from './client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type BrokenLinkReason = 'hash_mismatch' | 'prev_hash_mismatch';

export interface BrokenLink {
  /** Position within the verified range (ascending by timestamp). */
  index: number;
  /** Event identifier — safe to surface (opaque UUID). */
  eventId: string;
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Machine reason; exactly one of the allowed values. */
  reason: BrokenLinkReason;
}

export interface VerifyChainOptions {
  dateFrom?: string | null;
  dateTo?: string | null;
  /** Hard cap on events walked in a single call. Defaults to 10_000. */
  maxEvents?: number;
}

export interface VerifyChainResult {
  valid: boolean;
  totalEvents: number;
  brokenLinks: BrokenLink[];
  verifiedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

export const GENESIS_PREV_HASH = '0'.repeat(64);
const DEFAULT_MAX_EVENTS = 10_000;

// ─── Hash computation (must match publisher.computeEventHash) ───────────────

interface ChainableEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  source: string;
  actor?: unknown;
  agency?: unknown;
  resource?: unknown;
  context?: unknown;
  eventHash?: string;
  prevHash?: string;
}

export function computeEventHash(event: ChainableEvent): string {
  const payload = JSON.stringify({
    eventId: event.eventId,
    timestamp: event.timestamp,
    eventType: event.eventType,
    source: event.source,
    actor: event.actor,
    agency: event.agency,
    resource: event.resource,
    context: event.context,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ─── Index range computation (mirrors query.ts) ─────────────────────────────

function computeIndices(dateFrom?: string | null, dateTo?: string | null): string {
  if (!dateFrom && !dateTo) return allIndicesPattern();

  const start = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 365 * 86_400_000);
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

// ─── Pure chain walker (exported for unit tests) ────────────────────────────

/**
 * Walk a pre-fetched, ascending-by-timestamp slice of events and identify breaks.
 * Returns only { eventId, reason, timestamp, index } per broken link — no bodies.
 */
export function walkChain(events: ChainableEvent[]): Pick<VerifyChainResult, 'valid' | 'totalEvents' | 'brokenLinks'> {
  const sorted = [...events].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const brokenLinks: BrokenLink[] = [];
  let prevHash = GENESIS_PREV_HASH;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const computed = computeEventHash(event);
    const hashValid = event.eventHash === computed;
    // First event in an agency's chain uses GENESIS_PREV_HASH. The walker is
    // range-bounded, so for non-first ranges we still compare to the running
    // `prevHash` that we build from the previous event's stored `eventHash`.
    const chainValid = event.prevHash === prevHash;

    if (!hashValid) {
      brokenLinks.push({
        index: i,
        eventId: event.eventId,
        timestamp: event.timestamp,
        reason: 'hash_mismatch',
      });
    } else if (!chainValid) {
      brokenLinks.push({
        index: i,
        eventId: event.eventId,
        timestamp: event.timestamp,
        reason: 'prev_hash_mismatch',
      });
    }

    // Advance prevHash to the stored eventHash (if any) so downstream events
    // in a corrupted chain still report their *own* break rather than
    // cascading breaks from a single earlier mutation.
    prevHash = event.eventHash || computed;
  }

  return {
    valid: brokenLinks.length === 0,
    totalEvents: sorted.length,
    brokenLinks,
  };
}

// ─── ES reader (agency-scoped, PII-safe) ────────────────────────────────────

/**
 * Fetch all events for an agency in the given range, sorted ascending.
 * Only reads fields the verifier needs; does not expose raw bodies to callers
 * (the returned `events` never leave this module).
 */
async function fetchEventsForChain(
  agencyId: string,
  options: VerifyChainOptions,
): Promise<ChainableEvent[]> {
  const max = Math.min(options.maxEvents ?? DEFAULT_MAX_EVENTS, DEFAULT_MAX_EVENTS);
  const must: Record<string, unknown>[] = [
    { term: { 'agency.id': agencyId } },
    // Only consider events that are part of the chain. The bull worker's
    // log-transport.ts (marketing-identity-bull/src/lib/log-transport.ts)
    // ships operational worker logs to the same `audit-*` indices via
    // direct indexDocument calls, bypassing publishAuditEvent. Those docs
    // have no `eventHash` / `prevHash` and are NOT part of the chain — but
    // they sit alongside chained events in ES. Without this filter, the
    // chain walker treats them as ghost links and reports the next chained
    // event as `prev_hash_mismatch`. Worker logs remain visible in the
    // activity feed UI; they just don't participate in chain verification.
    { exists: { field: 'eventHash' } },
  ];

  // The E2E harness's `tests/support/audit-writer.ts` writes events with
  // `eventHash: ZERO_HASH` and `prevHash: ZERO_HASH` because they are
  // intentionally NOT linked into the real chain (see the module-level
  // comment in audit-writer.ts). The `{ exists: eventHash }` filter above
  // doesn't reject them — `'0'.repeat(64)` is a real value. Without this
  // exclusion, every zero-hashed event interleaved by timestamp into a
  // tenant's chain shows up as an event whose `prev_hash` doesn't match
  // its predecessor's `eventHash`, and the verifier reports a cascade
  // of broken links. Production code never writes zero hashes (the
  // publisher always computes a real HMAC), so the filter is safe to
  // apply unconditionally.
  const must_not: Record<string, unknown>[] = [
    { term: { eventHash: '0000000000000000000000000000000000000000000000000000000000000000' } },
  ];

  const { dateFrom, dateTo } = options;
  if (dateFrom || dateTo) {
    const range: Record<string, string> = {};
    if (dateFrom) range.gte = dateFrom;
    if (dateTo) range.lte = dateTo;
    must.push({ range: { timestamp: range } });
  }

  const queryBody = {
    query: { bool: { must, must_not } },
    sort: [{ timestamp: { order: 'asc' } }],
    size: max,
    track_total_hits: true,
  };

  const indices = computeIndices(dateFrom, dateTo);

  try {
    const result = await search(queryBody, indices);
    const hits = result.hits?.hits || [];
    return hits.map((h: { _source: Record<string, unknown> }) => h._source as unknown as ChainableEvent);
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) {
      return [];
    }
    throw err;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Verify the hash chain for an agency over a date range.
 *
 * @param agencyId  Tenant id — REQUIRED; every ES query filters on this.
 * @param options   Date window + limits.
 * @returns Pure-data result with only { eventId, reason, timestamp } per break.
 */
export async function verifyChain(
  agencyId: string,
  options: VerifyChainOptions = {},
): Promise<VerifyChainResult> {
  if (!agencyId) {
    throw new Error('agencyId is required for chain verification');
  }

  const events = await fetchEventsForChain(agencyId, options);
  const walk = walkChain(events);

  return {
    valid: walk.valid,
    totalEvents: walk.totalEvents,
    brokenLinks: walk.brokenLinks,
    verifiedAt: new Date().toISOString(),
  };
}

/**
 * Fetch the most recent event's `eventHash` for an agency, across all indices.
 * Used by the publisher to rehydrate `_lastHashByAgency` on process restart.
 *
 * Returns `null` if the agency has no prior events (legitimate first event)
 * or if ES is unavailable — callers treat `null` as "start from GENESIS".
 */
export async function getLatestEventHashForAgency(agencyId: string): Promise<string | null> {
  if (!agencyId) return null;

  const queryBody = {
    // Same filters as fetchEventsForChain:
    //   - exists eventHash → drop bull worker log-transport rows (no hash)
    //   - must_not eventHash=ZERO → drop E2E audit-writer.ts rows that are
    //     deliberately written un-chained. If the publisher returned a
    //     ZERO_HASH as `prevHash` for the next chained event, every
    //     subsequent chain row would point at GENESIS instead of the real
    //     previous hash — silently breaking the chain on the next write.
    query: {
      bool: {
        must: [
          { term: { 'agency.id': agencyId } },
          { exists: { field: 'eventHash' } },
        ],
        must_not: [
          { term: { eventHash: '0000000000000000000000000000000000000000000000000000000000000000' } },
        ],
      },
    },
    sort: [{ timestamp: { order: 'desc' } }],
    size: 1,
    _source: ['eventHash', 'timestamp'],
  };

  try {
    const result = await search(queryBody, allIndicesPattern());
    const hits = result.hits?.hits || [];
    if (hits.length === 0) return null;
    const src = hits[0]._source as { eventHash?: string };
    return src.eventHash || null;
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes('404') || msg.includes('index_not_found')) {
      return null;
    }
    // Propagate unexpected errors; the publisher decides how to degrade.
    throw err;
  }
}
