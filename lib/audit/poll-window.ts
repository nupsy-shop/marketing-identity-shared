// Reusable poll-window + dedup helpers for the *_poll_audit processors.
//
// Provider audit APIs (Google Reports, Entra, ad platforms) surface events with
// an ingestion lag: an event with eventTime T only becomes queryable at T+lag.
// A forward-only cursor (since = lastPoll, advance to now) permanently skips any
// event that surfaces after the cursor passed its eventTime. These helpers add a
// lookback overlap and dedup the overlap against the durable audit_events_mirror,
// so late events get ingested exactly once.

export interface PollWindowOptions {
  /** Hours of overlap subtracted from the cursor. Default 6 (Google Reports' typical worst-case lag). */
  lookbackHours?: number;
  /** Floor: never poll further back than now - maxHours. Default 24 (first-run / long-gap). */
  maxHours?: number;
  /** Injectable clock for tests. */
  now?: Date;
}

export function computePollSince(
  lastAuditPollAt: string | Date | null | undefined,
  opts: PollWindowOptions = {},
): Date {
  const now = opts.now ?? new Date();
  const lookbackMs = (opts.lookbackHours ?? 6) * 3600_000;
  const maxMs = (opts.maxHours ?? 24) * 3600_000;
  const floor = new Date(now.getTime() - maxMs);
  if (!lastAuditPollAt) return floor;
  const cursor = new Date(lastAuditPollAt);
  if (Number.isNaN(cursor.getTime())) return floor;
  const since = cursor.getTime() - lookbackMs;
  if (since < floor.getTime()) return floor;
  if (since > now.getTime()) return now;
  return new Date(since);
}

/** Stable dedup key for a provider event. Google persists `uniqueQualifier` as
 *  the audit `resource.id`; it is unique per (app, customer, time). */
export function eventDedupKey(uniqueQualifier: string | null | undefined): string | null {
  const q = uniqueQualifier?.trim();
  return q ? q : null;
}

/** Decide whether to publish an event seen in the (possibly overlapping) window. */
export function shouldPublishEvent(args: {
  key: string | null;
  eventTimeMs: number | null;
  seen: Set<string>;
  previousCursorMs: number | null;
}): boolean {
  const { key, eventTimeMs, seen, previousCursorMs } = args;
  if (key) return !seen.has(key);
  // Keyless events can't be deduped against the mirror (which stores only the
  // key). Avoid re-publishing the lookback overlap by gating on the PRE-run
  // cursor: only publish keyless events strictly newer than it. First run (no
  // cursor) or an unknown event time → publish rather than silently drop.
  if (previousCursorMs == null || eventTimeMs == null) return true;
  return eventTimeMs > previousCursorMs;
}

export interface PollSeenPrismaLike {
  auditEventsMirror: {
    findMany(args: {
      where: { agencyId: string; eventType: { startsWith: string }; occurredAt: { gte: Date } };
      select: { resourceId: true };
    }): Promise<Array<{ resourceId: string | null }>>;
  };
}

/** Load the dedup keys of events already recorded in [since, now] for this agency
 *  under the given eventType prefix. One batched, agency-scoped read of the mirror. */
export async function loadSeenEventKeys(args: {
  prisma: PollSeenPrismaLike;
  agencyId: string;
  since: Date;
  eventTypePrefix: string;
}): Promise<Set<string>> {
  const { prisma, agencyId, since, eventTypePrefix } = args;
  const rows = await prisma.auditEventsMirror.findMany({
    where: { agencyId, eventType: { startsWith: eventTypePrefix }, occurredAt: { gte: since } },
    select: { resourceId: true },
  });
  const set = new Set<string>();
  for (const r of rows) {
    const k = eventDedupKey(r.resourceId);
    if (k) set.add(k);
  }
  return set;
}
