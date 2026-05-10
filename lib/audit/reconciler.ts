/**
 * audit_reconcile_es — hourly cleanup pass.
 *
 * Finds audit_events that are missing from audit_es_index_state, or that
 * have indexedAt = NULL and attempts = 0 (job lost in transit), and
 * re-enqueues them for ES indexing. Bounded batch size to keep the cron cheap.
 *
 * Implementation note: uses prisma.auditEvent.findMany with the esIndexState
 * relation (AuditEvent.esIndexState?) rather than $queryRaw. This satisfies the
 * project convention (feedback_prisma_only / feedback_no_raw_sql) and requires
 * the FK added in migration 20260509000001_audit_es_index_relation.
 */
import { getRuntime } from '../runtime.js';

const BATCH_SIZE = 1000;

export async function runReconcileBatch(): Promise<void> {
  const { prisma, enqueueJob } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');

  const events = await prisma.auditEvent.findMany({
    where: {
      OR: [
        { esIndexState: null },
        { esIndexState: { indexedAt: null, attempts: 0 } },
      ],
    },
    orderBy: { timestamp: 'desc' },
    take: BATCH_SIZE,
    select: { eventId: true },
  });

  if (events.length === 0) return;
  if (!enqueueJob) return;

  await Promise.all(
    (events as Array<{ eventId: string }>).map((e) => enqueueJob('audit_index_es', { eventId: e.eventId })),
  );
}
