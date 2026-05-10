/**
 * Audit chain verifier (PG-walking).
 *
 * Reads audit_events for a given agency in (agency_id, seq) order and
 * reports any breaks. Pure read; never writes audit events; PII-safe.
 *
 * Note: this verifier checks chain CONTINUITY (prev_hash linkage) and
 * sequence DENSITY. It does NOT recompute event_hash from body — that
 * requires fetching from MinIO and is the responsibility of the
 * customer-facing inclusion-proof verifier (Plan C). The internal
 * verifier is for ops dashboards; the customer-facing one is what
 * a regulator inspects.
 */
import { getRuntime } from '../runtime.js';

export type BrokenLinkReason = 'prev_hash_mismatch' | 'sequence_gap';

export interface BrokenLink {
  index: number;
  eventId: string;
  timestamp: string;
  reason: BrokenLinkReason;
}

export interface VerifyChainOptions {
  agencyId: string;
  dateFrom?: Date | string | null;
  dateTo?: Date | string | null;
  maxEvents?: number;
}

export interface VerifyChainResult {
  valid: boolean;
  totalEvents: number;
  brokenLinks: BrokenLink[];
  /** ISO-8601 timestamp of when verification ran. Back-compat with old ES verifier. */
  verifiedAt: string;
}

const GENESIS = '0'.repeat(64);

/** @deprecated Use `GENESIS` (private). Exported for back-compat with audit-chain.test.ts. */
export const GENESIS_PREV_HASH = GENESIS;

export async function verifyChain(opts: VerifyChainOptions): Promise<VerifyChainResult> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  const cap = opts.maxEvents ?? 10_000;
  const where: Record<string, unknown> = { agencyId: opts.agencyId };
  if (opts.dateFrom || opts.dateTo) {
    const ts: Record<string, Date> = {};
    if (opts.dateFrom) ts.gte = opts.dateFrom instanceof Date ? opts.dateFrom : new Date(opts.dateFrom);
    if (opts.dateTo)   ts.lte = opts.dateTo instanceof Date ? opts.dateTo : new Date(opts.dateTo);
    where.timestamp = ts;
  }

  const events = await prisma.auditEvent.findMany({
    where,
    orderBy: { seq: 'asc' },
    take: cap,
    select: { seq: true, prevHash: true, eventHash: true, eventId: true, timestamp: true },
  });

  const broken: BrokenLink[] = [];
  let prevSeq: bigint | null = null;
  let prevHash = GENESIS;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (i === 0) {
      // First event in walk window — accept whatever prev it claims.
      // (Mid-chain windows are valid; only continuity within the window matters.)
    } else if (e.prevHash !== prevHash) {
      broken.push({
        index: i,
        eventId: e.eventId,
        timestamp: e.timestamp.toISOString(),
        reason: 'prev_hash_mismatch',
      });
    }
    if (prevSeq !== null && e.seq !== prevSeq + 1n) {
      // Gap — also expressed as prev_hash_mismatch since the chain breaks.
      if (broken[broken.length - 1]?.eventId !== e.eventId) {
        broken.push({
          index: i,
          eventId: e.eventId,
          timestamp: e.timestamp.toISOString(),
          reason: 'prev_hash_mismatch',
        });
      }
    }
    prevSeq = e.seq;
    prevHash = e.eventHash;
  }

  return {
    valid: broken.length === 0,
    totalEvents: events.length,
    brokenLinks: broken,
    verifiedAt: new Date().toISOString(),
  };
}

// Back-compat: old call sites used positional/legacy options. Wrap if needed.
export async function getLatestEventHashForAgency(agencyId: string): Promise<string | null> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  const head = await prisma.auditEvent.findFirst({
    where: { agencyId },
    orderBy: { seq: 'desc' },
    select: { eventHash: true },
  });
  return head?.eventHash ?? null;
}

// ─── Back-compat stubs for audit-chain.test.ts ──────────────────────────────
// These exports were present in the old ES-walking verify.ts and are imported
// by tests/unit/audit-chain.test.ts. They are preserved here so existing tests
// continue to compile. The new verifier does not use them internally.

import crypto from 'crypto';

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

/** @deprecated Kept for back-compat with audit-chain.test.ts. Not used by PG verifier. */
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

/** @deprecated Kept for back-compat with audit-chain.test.ts. Not used by PG verifier. */
export function walkChain(events: ChainableEvent[]): Pick<VerifyChainResult, 'valid' | 'totalEvents' | 'brokenLinks'> {
  const sorted = [...events].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  const brokenLinks: BrokenLink[] = [];
  let prevHash = GENESIS;

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i];
    const computed = computeEventHash(event);
    const hashValid = event.eventHash === computed;
    const chainValid = event.prevHash === prevHash;

    if (!hashValid) {
      brokenLinks.push({
        index: i,
        eventId: event.eventId,
        timestamp: event.timestamp,
        reason: 'prev_hash_mismatch',
      });
    } else if (!chainValid) {
      brokenLinks.push({
        index: i,
        eventId: event.eventId,
        timestamp: event.timestamp,
        reason: 'prev_hash_mismatch',
      });
    }

    prevHash = event.eventHash || computed;
  }

  return {
    valid: brokenLinks.length === 0,
    totalEvents: sorted.length,
    brokenLinks,
  };
}
