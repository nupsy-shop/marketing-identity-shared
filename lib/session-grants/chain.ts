/**
 * Session-grant event chain — canonical hash primitives (shared).
 *
 * The single source of truth for the tamper-evident `session_events`
 * hash chain. The web app (lib/sessionGrants.ts) keeps a byte-identical
 * copy of `GENESIS` / `canonicalJson` / `computeEventHash`; a drift-guard
 * unit test asserts the two agree. The Bull worker's per-agency expiry
 * sweep (./expire.ts) uses `appendSessionEvent` so it writes EXPIRED
 * events through the exact same algorithm.
 *
 * The hash layout is load-bearing: `sha256(prevHash + canonicalJson(
 * {sessionGrantId, ts, type, metadata}))`. Changing it would break
 * verification of every previously written chain.
 *
 * NOTE: shared code must not depend on a host-generated Prisma client
 * (the web and worker generate different clients), so the transaction
 * client is typed structurally rather than as `Prisma.TransactionClient`.
 */

import { createHash } from 'crypto';

/** Genesis prev_hash for the first event in a chain. */
export const GENESIS = 'GENESIS';

export interface SessionGrantHashPayload {
  sessionGrantId: string;
  ts: string;
  type: string;
  metadata: unknown;
}

export interface AppendEventInput {
  sessionGrantId: string;
  type: string;
  metadata?: unknown;
}

/** Minimal structural view of the Prisma transaction client we touch. */
export interface ChainTransactionClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  session_events: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
  };
}

/**
 * Deterministic JSON serializer with recursively sorted keys. Produces
 * identical output for identical data regardless of insertion order.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'boolean' || typeof obj === 'number') return JSON.stringify(obj);
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map((v) => canonicalJson(v)).join(',') + ']';
  }
  if (typeof obj === 'object') {
    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const pairs = keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k]));
    return '{' + pairs.join(',') + '}';
  }
  return JSON.stringify(obj);
}

/**
 * Compute the SHA-256 event hash: prevHash + canonicalJson(payload).
 * Returns a 64-char lowercase hex string.
 */
export function computeEventHash(prevHash: string, payload: SessionGrantHashPayload): string {
  const input = prevHash + canonicalJson(payload);
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Append one hash-chained event to a grant inside an existing
 * transaction. Locks the chain tip with `SELECT ... FOR UPDATE` to
 * prevent concurrent forks, links `prev_hash`, computes `event_hash`,
 * and inserts the `session_events` row.
 *
 * Mirrors lib/sessionGrants.ts:appendEventInternal. The FOR UPDATE row
 * lock requires raw SQL — it is not expressible through Prisma Client —
 * and is essential to the chain's integrity guarantee, so this is a
 * deliberate exception to the "Prisma only" rule.
 */
export async function appendSessionEvent(
  tx: ChainTransactionClient,
  input: AppendEventInput,
): Promise<void> {
  const lastEvents = await tx.$queryRaw<{ event_hash: string }[]>`
    SELECT event_hash FROM session_events
    WHERE session_grant_id = ${input.sessionGrantId}::uuid
    ORDER BY ts DESC, id DESC
    LIMIT 1
    FOR UPDATE
  `;

  const prevHash = lastEvents.length > 0 ? lastEvents[0].event_hash : GENESIS;
  const now = new Date();
  const eventPayload: SessionGrantHashPayload = {
    sessionGrantId: input.sessionGrantId,
    ts: now.toISOString(),
    type: input.type,
    metadata: input.metadata ?? null,
  };
  const eventHash = computeEventHash(prevHash, eventPayload);

  await tx.session_events.create({
    data: {
      session_grant_id: input.sessionGrantId,
      ts: now,
      type: input.type,
      prev_hash: prevHash,
      event_hash: eventHash,
      metadata: input.metadata ?? null,
    },
  });
}
