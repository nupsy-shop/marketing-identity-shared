/**
 * audit_reconcile_es — hourly cleanup pass.
 *
 * Finds audit_events that are missing from audit_es_index_state, or that
 * have indexedAt = NULL and attempts = 0 (job lost in transit), and
 * re-enqueues them for ES indexing. Bounded batch size to keep the cron cheap.
 *
 * Implementation note: this used to query `prisma.auditEvent.findMany` with a
 * nested `esIndexState` relation filter. The relation was backed by a FK from
 * audit_es_index_state.event_id → audit_events.event_id, but the FK trigger
 * surfaced as `permission denied for table audit_events` on Heroku Postgres
 * with the Prisma 7 + pg adapter combo (even though the runtime user owned the
 * table). Migration `20260510000000_audit_drop_index_state_fk` removed the FK
 * and the Prisma relation field; this code was left referencing the now-
 * non-existent `esIndexState` field, which made every reconcile tick throw
 * `PrismaClientValidationError`.
 *
 * The current implementation does the join in app code with two `findMany`
 * calls — still Prisma-only (satisfies `feedback_prisma_only` /
 * `feedback_no_raw_sql`) and aligned with the DB reality (no FK). The cost is
 * negligible: BATCH_SIZE rows from each table on an hourly cron.
 */
import { getRuntime } from '../runtime.js';

const BATCH_SIZE = 1000;

export async function runReconcileBatch(): Promise<void> {
  const { prisma, enqueueJob } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  if (!enqueueJob) return;

  // 1. Pull a recent window of audit_events.
  const events = await prisma.auditEvent.findMany({
    orderBy: { timestamp: 'desc' },
    take: BATCH_SIZE,
    select: { eventId: true },
  });
  if (events.length === 0) return;

  const eventIds = (events as Array<{ eventId: string }>).map((e) => e.eventId);

  // 2. Pull matching index-state rows in one shot.
  const states = await prisma.auditEsIndexState.findMany({
    where: { eventId: { in: eventIds } },
    select: { eventId: true, indexedAt: true, attempts: true },
  });
  const stateByEventId = new Map<string, { indexedAt: Date | null; attempts: number }>(
    (states as Array<{ eventId: string; indexedAt: Date | null; attempts: number }>).map((s) => [
      s.eventId,
      { indexedAt: s.indexedAt, attempts: s.attempts },
    ]),
  );

  // 3. Re-enqueue events that are missing a state row OR have a stalled row
  //    (indexedAt = NULL && attempts = 0 → job lost in transit).
  const toEnqueue = eventIds.filter((id) => {
    const s = stateByEventId.get(id);
    if (!s) return true; // missing
    return s.indexedAt === null && s.attempts === 0; // stalled
  });

  if (toEnqueue.length === 0) return;

  await Promise.all(
    toEnqueue.map((id) => enqueueJob('audit_index_es', { eventId: id })),
  );
}
