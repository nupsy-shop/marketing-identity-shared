/**
 * Audit Retention Sweep — Plugin Processor.
 *
 * Daily Bull job (registered in marketing-identity-bull). For each agency:
 *
 *   1. Read `agency_settings.audit_retention_days`, `audit_legal_hold`,
 *      `audit_sensitive_extended`.
 *   2. Skip when `audit_legal_hold = true` (hold blocks ALL deletes).
 *   3. Skip when `audit_retention_days < 0` (forever).
 *   4. Delete `audit_events` rows older than `now() - retention_days` for
 *      that agency. When `audit_sensitive_extended = true`, exclude rows
 *      whose `event_type` matches one of SENSITIVE_PATTERNS.
 *   5. Drop ES indices entirely older than the cutoff (cheaper than
 *      per-doc delete).
 *   6. Emit `siem.retention.swept` audit event with the deleted row count.
 *
 * Concurrency 1 (one sweep at a time, agencies iterated in series).
 * BullMQ attempts: 1 — there's no idempotency story for partial-failure
 * resume; the next day's run catches up.
 *
 * Dependencies on web:
 *   - `audit_events.event_type` column (denormalized so the sensitive
 *     filter is SQL-side; web pointer-bump prerequisite).
 *
 * dryRun mode: when `job.data.dryRun === true`, COUNT only, do not delete.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../lib/runtime.js';
import { publishAuditEvent } from '../../../lib/audit/publisher.js';

// Event-type prefixes/exact-matches considered sensitive — kept past the
// standard cutoff when an agency has `audit_sensitive_extended = true`.
// Stored as plain prefix / exact strings so they can compile into a
// parameterized SQL `event_type LIKE 'credential.%' OR event_type = '...'`
// without needing Postgres regex.
const SENSITIVE_PREFIXES = ['credential.', 'policy.', 'siem.legal_hold.'];
const SENSITIVE_EXACT = ['identity.deleted'];

interface JobData {
  /** Optional override for testing — sweep only this agency. */
  agencyId?: string;
  /** Count-only mode; no rows deleted. */
  dryRun?: boolean;
}

export interface SweepAgencyResult {
  agencyId: string;
  skipped?: 'legal_hold' | 'forever' | 'no_settings';
  cutoff?: string;
  deletedRows: number;
  esIndicesDropped: number;
  dryRun: boolean;
}

interface SweepJobResult {
  status: 'completed';
  jobType: 'audit_retention_sweep';
  agenciesProcessed: number;
  totalDeleted: number;
  results: SweepAgencyResult[];
}

export default async function retentionSweep(job: Bull.Job): Promise<SweepJobResult> {
  const { agencyId, dryRun = false } = (job.data ?? {}) as JobData;
  const { prisma, logger } = getRuntime();
  if (!prisma) throw new Error('[audit-retention] runtime.prisma not registered');

  const agencyIds = agencyId
    ? [agencyId]
    : (await prisma.agency_settings.findMany({
        select: { agency_id: true },
      })).map((r: { agency_id: string }) => r.agency_id);

  logger.info('audit_retention_sweep: starting', {
    jobId: String(job.id),
    agencyCount: agencyIds.length,
    dryRun,
  });

  const results: SweepAgencyResult[] = [];
  let totalDeleted = 0;
  for (const aid of agencyIds) {
    try {
      const r = await sweepAgency(aid, dryRun);
      results.push(r);
      totalDeleted += r.deletedRows;
    } catch (err) {
      logger.error('audit_retention_sweep: agency failed', {
        jobId: String(job.id),
        agencyId: aid,
        error: (err as Error).message,
      });
      results.push({ agencyId: aid, deletedRows: 0, esIndicesDropped: 0, dryRun });
    }
  }

  logger.info('audit_retention_sweep: completed', {
    jobId: String(job.id),
    agenciesProcessed: results.length,
    totalDeleted,
    dryRun,
  });

  return {
    status: 'completed',
    jobType: 'audit_retention_sweep',
    agenciesProcessed: results.length,
    totalDeleted,
    results,
  };
}

export async function sweepAgency(agencyId: string, dryRun: boolean): Promise<SweepAgencyResult> {
  const { prisma } = getRuntime();
  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
    select: {
      audit_retention_days: true,
      audit_legal_hold: true,
      audit_sensitive_extended: true,
    },
  });
  if (!settings) {
    return { agencyId, skipped: 'no_settings', deletedRows: 0, esIndicesDropped: 0, dryRun };
  }
  if (settings.audit_legal_hold) {
    return { agencyId, skipped: 'legal_hold', deletedRows: 0, esIndicesDropped: 0, dryRun };
  }
  if (settings.audit_retention_days < 0) {
    return { agencyId, skipped: 'forever', deletedRows: 0, esIndicesDropped: 0, dryRun };
  }

  const cutoff = new Date(Date.now() - settings.audit_retention_days * 86_400_000);

  // Build the WHERE for the range delete. Postgres prepared param indexes
  // are 1-based. We always parameterize agency_id + cutoff. When sensitive
  // extension is enabled we append AND NOT (event_type LIKE $3 OR ...).
  const params: Array<string | Date> = [agencyId, cutoff];
  let sensitiveClause = '';
  if (settings.audit_sensitive_extended) {
    const orParts: string[] = [];
    for (const prefix of SENSITIVE_PREFIXES) {
      params.push(`${prefix}%`);
      orParts.push(`event_type LIKE $${params.length}`);
    }
    for (const exact of SENSITIVE_EXACT) {
      params.push(exact);
      orParts.push(`event_type = $${params.length}`);
    }
    if (orParts.length > 0) {
      sensitiveClause = ` AND NOT (${orParts.join(' OR ')})`;
    }
  }

  let deletedRows = 0;
  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::bigint AS c FROM audit_events
        WHERE agency_id = $1::uuid AND created_at < $2${sensitiveClause}`,
      ...params,
    );
    const c = rows?.[0]?.c;
    deletedRows = typeof c === 'bigint' ? Number(c) : Number(c ?? 0);
  } else {
    deletedRows = await prisma.$executeRawUnsafe(
      `DELETE FROM audit_events
        WHERE agency_id = $1::uuid AND created_at < $2${sensitiveClause}`,
      ...params,
    );
  }

  const esIndicesDropped = await dropEsIndicesOlderThan(cutoff, dryRun);

  await publishAuditEvent({
    eventType: 'siem.retention.swept',
    severity: 'info',
    source: 'accesshive',
    agency: { id: agencyId },
    actor: { id: 'system', type: 'system' },
    context: {
      deletedRows,
      esIndicesDropped,
      cutoff: cutoff.toISOString(),
      dryRun,
      sensitiveExtended: Boolean(settings.audit_sensitive_extended),
    },
  }).catch(() => { /* publish failure must not fail the sweep */ });

  return { agencyId, cutoff: cutoff.toISOString(), deletedRows, esIndicesDropped, dryRun };
}

/**
 * Drops daily ES indices entirely older than the cutoff. Looks up the
 * client via runtime; returns 0 when no ES client is registered.
 *
 * Index naming convention is per-day, e.g. `audit-events-2026-05-01`.
 * We list indices, parse the date from the suffix, and DELETE the index
 * when its bucketed day is strictly before the cutoff day.
 */
async function dropEsIndicesOlderThan(cutoff: Date, dryRun: boolean): Promise<number> {
  const runtime = getRuntime() as unknown as {
    getEsClient?: () => { cat: { indices: (args: { index: string; format: 'json' }) => Promise<Array<{ index: string }>> }; indices: { delete: (args: { index: string }) => Promise<unknown> } } | null;
  };
  const es = runtime.getEsClient?.();
  if (!es) return 0;

  let indices: Array<{ index: string }> = [];
  try {
    indices = await es.cat.indices({ index: 'audit-events-*', format: 'json' });
  } catch {
    return 0;
  }
  const cutoffDayUtc = Date.UTC(
    cutoff.getUTCFullYear(),
    cutoff.getUTCMonth(),
    cutoff.getUTCDate(),
  );
  let dropped = 0;
  for (const row of indices) {
    const m = /^audit-events-(\d{4})-(\d{2})-(\d{2})$/.exec(row.index);
    if (!m) continue;
    const dayUtc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (dayUtc >= cutoffDayUtc) continue;
    if (!dryRun) {
      try {
        await es.indices.delete({ index: row.index });
      } catch {
        continue;
      }
    }
    dropped += 1;
  }
  return dropped;
}
