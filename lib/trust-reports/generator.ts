/**
 * Trust Report Generator — per-agency orchestrator (shared port of #57).
 *
 * One function both the legacy web scheduler script (`scripts/generate-trust-reports.ts`)
 * and the per-agency Bull worker (`generate-trust-reports-for-agency`) call.
 *
 * Behaviour:
 *   - Entitlement-gated on `features.clientTrustReports`. The entitlement
 *     resolver is passed in by the host (web has a Redis-cached Lago
 *     resolver; worker may short-circuit or wire its own).
 *   - Iterates clients where `trust_report_enabled = true, status = 'active'`.
 *   - Double-scopes every query by (agency_id, client_id).
 *   - Idempotent via the unique constraint on
 *     `trust_report_delivery_log (agency_id, client_id, quarter_start)`.
 *     A conflict on the insert means the quarter is already handled — we
 *     skip, or retry dispatch if the prior run failed at the dispatch stage.
 *   - Never calls SMTP directly — always emits through
 *     `dispatchNotification`. Email channels subscribed to
 *     `client.trust_report.delivered` fan out the actual email.
 *   - Generation failure → `client.trust_report.failed` (stage=render).
 *   - Dispatch failure → `client.trust_report.failed` (stage=dispatch).
 *     Render success is preserved so the next run can retry dispatch
 *     without regenerating.
 *   - Payload carries no PII beyond identifiers — audit stays clean.
 *
 * Prisma is pulled via `getRuntime()`. Host-specific concerns (Lago
 * entitlement lookup, optional dry-run mode) are passed as arguments.
 */

import { getRuntime } from '../runtime.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { priorQuarter } from './quarter.js';
import type { Quarter } from './quarter.js';
import { assembleTrustReport } from './assembler.js';
import { renderTrustReportPdf } from './pdf.js';
import { storeReport } from './s3-uploader.js';

export interface TrustReportGenerationInput {
  agencyId: string;
  /** Optional agency slug — stamped on audit payloads. */
  agencySlug?: string | null;
  /** Frozen-time hook for tests. Defaults to `new Date()`. */
  now?: Date;
  /**
   * Host-provided entitlement resolver. Returns `true` iff this agency
   * has `features.clientTrustReports` enabled. Errors must surface as
   * `false` to skip the agency cleanly (wrapped inside this helper).
   */
  resolveEntitled: (agencyId: string) => Promise<boolean>;
  /** Skip persistence and dispatch — still compute payloads. */
  dryRun?: boolean;
}

export interface TrustReportGenerationResult {
  agencyId: string;
  entitled: boolean;
  clientsProcessed: number;
  clientsSkippedAlreadyDelivered: number;
  reportsGenerated: number;
  reportsDelivered: number;
  generationFailures: number;
  dispatchFailures: number;
}

export async function generateTrustReportsForAgency(
  input: TrustReportGenerationInput,
): Promise<TrustReportGenerationResult> {
  const { agencyId, agencySlug, now = new Date(), resolveEntitled, dryRun = false } = input;
  const { prisma, logger } = getRuntime();

  const result: TrustReportGenerationResult = {
    agencyId,
    entitled: false,
    clientsProcessed: 0,
    clientsSkippedAlreadyDelivered: 0,
    reportsGenerated: 0,
    reportsDelivered: 0,
    generationFailures: 0,
    dispatchFailures: 0,
  };

  // Entitlement gate — host decides how to resolve.
  let entitled = false;
  try {
    entitled = await resolveEntitled(agencyId);
  } catch (err) {
    logger.warn(
      `[trust-reports] entitlement resolver threw for agency=${agencyId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    entitled = false;
  }
  result.entitled = entitled;
  if (!entitled) return result;

  const quarter = priorQuarter(now);
  logger.info(
    `[trust-reports] agency=${agencyId} quarter=${quarter.label} (${quarter.startDate} → ${quarter.endDate})${
      dryRun ? ' DRY RUN' : ''
    }`,
  );

  // Agency-scoped opted-in clients.
  const clients = await prisma.clients.findMany({
    where: { agency_id: agencyId, trust_report_enabled: true, status: 'active' },
    select: { id: true, name: true },
  });

  for (const client of clients as Array<{ id: string; name: string }>) {
    await processClient({
      agencyId,
      agencySlug: agencySlug ?? null,
      client,
      quarter,
      dryRun,
      result,
    });
  }

  return result;
}

// ── Per-client processing ──────────────────────────────────────────────

interface ProcessClientArgs {
  agencyId: string;
  agencySlug: string | null;
  client: { id: string; name: string };
  quarter: Quarter;
  dryRun: boolean;
  result: TrustReportGenerationResult;
}

async function processClient(args: ProcessClientArgs): Promise<void> {
  const { agencyId, agencySlug, client, quarter, dryRun, result } = args;
  const { prisma, logger } = getRuntime();

  // ── Idempotency: try to claim the (agency, client, quarter_start) row ──
  let logRow: { id: string } | null = null;
  try {
    logRow = await prisma.trust_report_delivery_log.create({
      data: {
        agency_id: agencyId,
        client_id: client.id,
        quarter_start: new Date(quarter.start),
        quarter_end: new Date(quarter.end),
        status: 'generating',
        contact_ids: [],
      },
      select: { id: true },
    });
  } catch (err) {
    const existing = await prisma.trust_report_delivery_log.findUnique({
      where: {
        agency_id_client_id_quarter_start: {
          agency_id: agencyId,
          client_id: client.id,
          quarter_start: new Date(quarter.start),
        },
      },
    });
    if (!existing) {
      logger.warn('[trust-reports] claim insert failed and no row found', {
        agencyId,
        clientId: client.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    if (existing.status === 'delivered' || existing.status === 'generated') {
      result.clientsSkippedAlreadyDelivered++;
      return;
    }
    if (
      existing.status === 'failed' &&
      existing.failed_stage === 'dispatch' &&
      existing.report_url
    ) {
      await retryDispatch({
        agencyId,
        agencySlug,
        client,
        quarter,
        logRowId: existing.id,
        reportUrl: existing.report_url,
        dryRun,
        result,
      });
    }
    return;
  }

  if (!logRow) return;
  result.clientsProcessed++;

  // ── Render stage ──────────────────────────────────────────────────────
  let reportBytes: Uint8Array;
  try {
    const payload = await assembleTrustReport({
      agencyId,
      clientId: client.id,
      quarter,
    });
    const rendered = await renderTrustReportPdf(payload);
    reportBytes = rendered.bytes;
  } catch (err) {
    result.generationFailures++;
    const reason = err instanceof Error ? err.message : String(err);
    await prisma.trust_report_delivery_log.update({
      where: { id: logRow.id },
      data: {
        status: 'failed',
        failed_stage: 'render',
        failed_reason: reason,
        updated_at: new Date(),
      },
    });
    await safeDispatch(agencyId, 'client.trust_report.failed', {
      client: client.name,
      clientId: client.id,
      agencyId,
      quarterStart: quarter.startDate,
      quarterEnd: quarter.endDate,
      stage: 'render',
      reason,
    }, dryRun);
    return;
  }

  // ── Upload stage ──────────────────────────────────────────────────────
  const reportUrl = await storeReport({
    agency: { id: agencyId, slug: agencySlug },
    client: { id: client.id },
    quarter: { startDate: quarter.startDate },
    bytes: reportBytes,
  });

  result.reportsGenerated++;
  await prisma.trust_report_delivery_log.update({
    where: { id: logRow.id },
    data: { status: 'generated', report_url: reportUrl, updated_at: new Date() },
  });

  await safeDispatch(agencyId, 'client.trust_report.generated', {
    client: client.name,
    clientId: client.id,
    agencyId,
    quarterStart: quarter.startDate,
    quarterEnd: quarter.endDate,
    reportUrl,
  }, dryRun);

  // ── Resolve contacts (client-scoped) ──────────────────────────────────
  const contacts = await prisma.client_contacts.findMany({
    where: {
      agency_id: agencyId,
      client_id: client.id,
      trust_report_subscribed: true,
    },
    select: { id: true, email: true, name: true },
  });
  const contactIds = (contacts as Array<{ id: string }>).map((c) => c.id);

  // ── Dispatch stage ────────────────────────────────────────────────────
  try {
    if (dryRun) {
      logger.info('[trust-reports] DRY RUN — skipping dispatch', {
        agencyId,
        clientId: client.id,
        contacts: contacts.length,
      });
    } else {
      await dispatchNotification(agencyId, 'client.trust_report.delivered', {
        client: client.name,
        clientId: client.id,
        agencyId,
        quarterStart: quarter.startDate,
        quarterEnd: quarter.endDate,
        reportUrl,
        contactIds,
      });
    }
    result.reportsDelivered++;
    await prisma.trust_report_delivery_log.update({
      where: { id: logRow.id },
      data: {
        status: 'delivered',
        delivered_at: new Date(),
        contact_ids: contactIds,
        updated_at: new Date(),
      },
    });
  } catch (err) {
    result.dispatchFailures++;
    const reason = err instanceof Error ? err.message : String(err);
    await prisma.trust_report_delivery_log.update({
      where: { id: logRow.id },
      data: {
        status: 'failed',
        failed_stage: 'dispatch',
        failed_reason: reason,
        contact_ids: contactIds,
        updated_at: new Date(),
      },
    });
    await safeDispatch(agencyId, 'client.trust_report.failed', {
      client: client.name,
      clientId: client.id,
      agencyId,
      quarterStart: quarter.startDate,
      quarterEnd: quarter.endDate,
      stage: 'dispatch',
      reason,
    }, dryRun);
  }
}

// ── Dispatch-only retry path ───────────────────────────────────────────

interface RetryDispatchArgs {
  agencyId: string;
  agencySlug: string | null;
  client: { id: string; name: string };
  quarter: Quarter;
  logRowId: string;
  reportUrl: string;
  dryRun: boolean;
  result: TrustReportGenerationResult;
}

async function retryDispatch(args: RetryDispatchArgs): Promise<void> {
  const { agencyId, client, quarter, logRowId, reportUrl, dryRun, result } = args;
  const { prisma } = getRuntime();

  const contacts = await prisma.client_contacts.findMany({
    where: {
      agency_id: agencyId,
      client_id: client.id,
      trust_report_subscribed: true,
    },
    select: { id: true },
  });
  const contactIds = (contacts as Array<{ id: string }>).map((c) => c.id);

  try {
    if (!dryRun) {
      await dispatchNotification(agencyId, 'client.trust_report.delivered', {
        client: client.name,
        clientId: client.id,
        agencyId,
        quarterStart: quarter.startDate,
        quarterEnd: quarter.endDate,
        reportUrl,
        contactIds,
      });
    }
    result.reportsDelivered++;
    await prisma.trust_report_delivery_log.update({
      where: { id: logRowId },
      data: {
        status: 'delivered',
        delivered_at: new Date(),
        failed_reason: null,
        failed_stage: null,
        updated_at: new Date(),
      },
    });
  } catch (err) {
    result.dispatchFailures++;
    await prisma.trust_report_delivery_log.update({
      where: { id: logRowId },
      data: {
        status: 'failed',
        failed_stage: 'dispatch',
        failed_reason: err instanceof Error ? err.message : String(err),
        updated_at: new Date(),
      },
    });
  }
}

async function safeDispatch(
  agencyId: string,
  eventType: string,
  context: Record<string, unknown>,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return;
  const { logger } = getRuntime();
  try {
    await dispatchNotification(agencyId, eventType, context);
  } catch (err) {
    logger.warn('[trust-reports] dispatchNotification failed', {
      agencyId,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
