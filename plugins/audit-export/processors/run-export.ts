/**
 * audit_export_run — Bull processor for scheduled audit exports.
 *
 * One job per (schedule × trigger). Loads the `audit_export_schedules`
 * row, runs `queryAuditEvents(filters)`, applies the agency's masking
 * settings with viewer context `export`, formats the rows per
 * schedule.format (csv | json | ndjson), uploads to MinIO, and emails
 * each recipient a 7-day presigned URL. Updates the row with run state
 * (last_run_at, last_outcome, last_error, next_run_at) and emits a
 * `siem.export.run` audit event.
 *
 * Concurrency 3 per dyno. attempts=1 — failures are recorded on the
 * schedule row; the next repeatable tick or run-now retries.
 *
 * Job payload:
 *   { scheduleId: string; agencyId: string; trigger: 'cron' | 'manual' }
 *
 * Job IDs (for BullMQ dedupe):
 *   - cron:   audit-export:cron:{scheduleId}
 *   - manual: audit-export:manual:{scheduleId}:{ISO}
 */

import type Bull from 'bull';
import { getRuntime } from '../../../lib/runtime.js';
import { publishAuditEvent } from '../../../lib/audit/publisher.js';
import { queryAuditEvents } from '../../../lib/audit/query.js';
import { formatEvents, type ExportFormat } from '../../../lib/audit-export/format.js';
import { uploadExport } from '../../../lib/audit-export/storage.js';
import { sendExportReadyEmail } from '../../../lib/audit-export/email.js';
import { parseCron } from '../../../lib/audit-export/cron.js';
import type { MaskingSettings } from '../../../lib/audit/masking.js';

interface JobData {
  scheduleId: string;
  agencyId: string;
  trigger: 'cron' | 'manual';
}

interface ScheduleRow {
  id: string;
  agency_id: string;
  name: string;
  format: string;
  cron: string;
  filters: Record<string, unknown> | null;
  recipients: string[];
  enabled: boolean;
}

interface AgencyRow {
  id: string;
  slug: string | null;
}

interface SettingsRow {
  audit_masking: MaskingSettings | null;
}

interface RunResult {
  status: 'completed';
  jobType: 'audit_export_run';
  scheduleId: string;
  outcome: 'ok' | 'failed';
  key?: string;
  rows?: number;
  delivered?: number;
}

const DEFAULT_MASKING: MaskingSettings = {
  piiMode: 'exports',
  stripBodiesOnFailure: true,
  anonymizeAuditor: true,
};

const ALLOWED_FORMATS: ReadonlySet<string> = new Set(['csv', 'json', 'ndjson']);
const MAX_ROWS = 100_000;

export default async function runExport(job: Bull.Job): Promise<RunResult> {
  const { prisma, logger } = getRuntime();
  if (!prisma) throw new Error('[audit-export] runtime.prisma not registered');

  const data = (job.data ?? {}) as Partial<JobData>;
  if (!data.scheduleId || !data.agencyId) {
    throw new Error('[audit-export] job payload missing scheduleId/agencyId');
  }
  const trigger: 'cron' | 'manual' = data.trigger === 'manual' ? 'manual' : 'cron';

  logger.info('audit_export_run: starting', {
    jobId: String(job.id),
    scheduleId: data.scheduleId,
    agencyId: data.agencyId,
    trigger,
  });

  const schedule = (await prisma.audit_export_schedules.findFirst({
    where: { id: data.scheduleId, agency_id: data.agencyId },
  })) as ScheduleRow | null;

  if (!schedule) {
    throw new Error(`[audit-export] schedule ${data.scheduleId} not found for agency ${data.agencyId}`);
  }
  if (!ALLOWED_FORMATS.has(schedule.format)) {
    return finalizeFailure(prisma, schedule, `unsupported format: ${schedule.format}`);
  }

  const runAt = new Date();
  const isoTimestamp = runAt.toISOString();

  try {
    const settings = (await prisma.agency_settings.findUnique({
      where: { agency_id: data.agencyId },
      select: { audit_masking: true },
    })) as SettingsRow | null;
    const masking = (settings?.audit_masking as MaskingSettings | null) ?? DEFAULT_MASKING;

    const agencyRow = (await prisma.agencies.findUnique({
      where: { id: data.agencyId },
      select: { id: true, slug: true },
    })) as AgencyRow | null;

    const filters = (schedule.filters ?? {}) as Record<string, unknown>;
    const result = await queryAuditEvents({
      ...filters,
      agencyId: schedule.agency_id,
      limit: MAX_ROWS,
    });

    const formatted = formatEvents({
      format: schedule.format as ExportFormat,
      events: result.data as unknown as Parameters<typeof formatEvents>[0]['events'],
      masking,
      agencyId: schedule.agency_id,
    });

    const upload = await uploadExport({
      agencyId: schedule.agency_id,
      scheduleId: schedule.id,
      isoTimestamp,
      extension: formatted.extension,
      contentType: formatted.contentType,
      bytes: formatted.bytes,
    });

    const email = await sendExportReadyEmail({
      agencyId: schedule.agency_id,
      agencySlug: agencyRow?.slug ?? null,
      scheduleName: schedule.name,
      runIsoTimestamp: isoTimestamp,
      presignedUrl: upload.presignedUrl,
      recipients: schedule.recipients,
    });

    const nextRun = parseCron(schedule.cron, runAt).nextRun ?? null;

    await prisma.audit_export_schedules.update({
      where: { id: schedule.id },
      data: {
        last_run_at: runAt,
        last_outcome: 'ok',
        last_error: null,
        next_run_at: nextRun,
      },
    });

    await publishAuditEvent({
      eventType: 'siem.export.run',
      severity: 'info',
      source: 'accesshive',
      agency: { id: schedule.agency_id, slug: agencyRow?.slug ?? undefined },
      actor: { id: 'system', type: 'system' },
      resource: { type: 'audit_export_schedule', id: schedule.id, name: schedule.name },
      context: {
        trigger,
        outcome: 'ok',
        rows: result.total,
        bytes: upload.sizeBytes,
        format: schedule.format,
        key: upload.key,
        recipientsAttempted: email.attempted,
        recipientsDelivered: email.delivered,
        recipientsFailed: email.failures.length,
      },
    }).catch(() => { /* publish failure must not fail the export */ });

    logger.info('audit_export_run: completed', {
      jobId: String(job.id),
      scheduleId: schedule.id,
      rows: result.total,
      delivered: email.delivered,
    });

    return {
      status: 'completed',
      jobType: 'audit_export_run',
      scheduleId: schedule.id,
      outcome: 'ok',
      key: upload.key,
      rows: result.total,
      delivered: email.delivered,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('audit_export_run: failed', {
      jobId: String(job.id),
      scheduleId: schedule.id,
      error: message,
    });
    return finalizeFailure(prisma, schedule, message);
  }
}

async function finalizeFailure(
  prisma: ReturnType<typeof getRuntime>['prisma'],
  schedule: ScheduleRow,
  errorMessage: string,
): Promise<RunResult> {
  const runAt = new Date();
  const nextRun = parseCron(schedule.cron, runAt).nextRun ?? null;
  await prisma.audit_export_schedules.update({
    where: { id: schedule.id },
    data: {
      last_run_at: runAt,
      last_outcome: 'failed',
      last_error: errorMessage.slice(0, 1024),
      next_run_at: nextRun,
    },
  });

  await publishAuditEvent({
    eventType: 'siem.export.run',
    severity: 'warning',
    source: 'accesshive',
    agency: { id: schedule.agency_id },
    actor: { id: 'system', type: 'system' },
    resource: { type: 'audit_export_schedule', id: schedule.id, name: schedule.name },
    context: { outcome: 'failed', error: errorMessage.slice(0, 256) },
  }).catch(() => {});

  return {
    status: 'completed',
    jobType: 'audit_export_run',
    scheduleId: schedule.id,
    outcome: 'failed',
  };
}
