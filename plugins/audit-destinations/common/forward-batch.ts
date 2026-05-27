/**
 * Generic forward-batch processor factory.
 *
 * Every audit-destination plugin's `processors/{key}-forward.ts` is a
 * three-line file that calls `createForwardProcessor` with its own
 * `formatBatch` / `sendBatch` pair. This factory owns:
 *
 *   1. Loading the destination row + decrypted auth.
 *   2. Calling the plugin's wire-format `sendBatch`.
 *   3. Routing the outcome through recordSuccess / recordFailure.
 *
 * Bull retry is intentionally disabled on the AUDIT_FORWARDING queue
 * (attempts: 1, set worker-side). `recordFailure` owns retry semantics
 * via the 5-failure auto-disable rule.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../lib/runtime.js';
import { recordSuccess, recordFailure } from '../../../lib/audit-destinations/stats.js';
import { isEncrypted, decryptCredential } from '../../../lib/siem/crypto.js';
import type { AuditEvent, SendResult } from './audit-destination-plugin.interface.js';

export interface ForwardBatchJobData {
  destinationId: string;
  agencyId: string;
  pluginKey: string;
  events: AuditEvent[];
}

export interface ForwardBatchResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: string;
  destinationId?: string;
  delivered?: number;
  reason?: string;
}

export interface ForwardClient {
  formatBatch: (events: AuditEvent[], config: any) => unknown; // eslint-disable-line @typescript-eslint/no-explicit-any
  sendBatch: (
    formatted: any,                                            // eslint-disable-line @typescript-eslint/no-explicit-any
    config: any,                                               // eslint-disable-line @typescript-eslint/no-explicit-any
    auth: any,                                                 // eslint-disable-line @typescript-eslint/no-explicit-any
    agencyId: string,
  ) => Promise<SendResult>;
}

/**
 * Walk every string field in `auth` and decrypt the ones that bear the
 * `encrypted:aes256:` prefix. Idempotent — non-encrypted values pass
 * through unchanged. Avoids per-plugin sensitive-field lists at the cost
 * of a few extra `isEncrypted` checks per job.
 */
function decryptAuthInPlace(auth: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...auth };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      out[key] = decryptCredential(value);
    }
  }
  return out;
}

export function createForwardProcessor(
  jobType: string,
  client: ForwardClient,
): (job: Bull.Job) => Promise<ForwardBatchResult> {
  return async function forwardBatch(job: Bull.Job): Promise<ForwardBatchResult> {
    const { prisma, logger } = getRuntime();
    if (!prisma) throw new Error(`[${jobType}] runtime.prisma not registered`);

    const data = job.data as ForwardBatchJobData;
    const { destinationId, agencyId, events } = data;

    if (!destinationId || !agencyId || !Array.isArray(events) || events.length === 0) {
      logger.warn(`${jobType}: missing/empty payload, skipping`, {
        jobId: String(job.id),
        hasDestinationId: !!destinationId,
        hasAgencyId:      !!agencyId,
        eventCount:       Array.isArray(events) ? events.length : 0,
      });
      return { status: 'skipped', jobType, reason: 'missing required fields or empty batch' };
    }

    const dest = await prisma.audit_destinations.findFirst({
      where: { id: destinationId, agency_id: agencyId, enabled: true },
      select: { id: true, config: true, auth: true },
    });
    if (!dest) {
      // Destination disabled or removed between dispatch and processing.
      // Not a delivery failure — don't increment the failure counter.
      return { status: 'skipped', jobType, destinationId, reason: 'destination not found, disabled, or wrong agency' };
    }

    const config = (dest.config ?? {}) as Record<string, unknown>;
    const auth   = decryptAuthInPlace((dest.auth ?? {}) as Record<string, unknown>);

    let result: SendResult;
    try {
      const formatted = client.formatBatch(events, config);
      result = await client.sendBatch(formatted, config, auth, agencyId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await recordFailure(destinationId, events.length, message);
      logger.warn(`${jobType}: send threw`, { jobId: String(job.id), destinationId, error: message });
      return { status: 'failed', jobType, destinationId, reason: message };
    }

    if (result.success) {
      await recordSuccess(destinationId, events.length);
      logger.info(`${jobType}: delivered`, {
        jobId: String(job.id), destinationId, delivered: events.length, responseTimeMs: result.responseTimeMs,
      });
      return { status: 'completed', jobType, destinationId, delivered: events.length };
    }

    const errorMsg = result.error ?? 'unknown send failure';
    await recordFailure(destinationId, events.length, errorMsg);
    logger.warn(`${jobType}: delivery failed`, { jobId: String(job.id), destinationId, error: errorMsg });
    return { status: 'failed', jobType, destinationId, reason: errorMsg };
  };
}
