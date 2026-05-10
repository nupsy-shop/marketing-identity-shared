/**
 * audit_index_es job handler. Runs on the bull worker dyno.
 *
 * Reads the audit_events row, fetches the canonical body from MinIO,
 * recomputes bodySha256 as a defensive integrity check, indexes the
 * doc to ES, and updates audit_es_index_state.
 *
 * Failure cases:
 *   - PG row not found: log + ack (no retry — job for a deleted/non-existent event).
 *   - MinIO not found: log + record lastError + retry (transient).
 *   - bodySha256 mismatch: HARD ERROR — log + record lastError + DO NOT retry
 *     (this would mean the body in MinIO has been tampered or the chain row
 *     is wrong; either way human investigation needed).
 *   - ES index failure: record lastError + rethrow for Bull retry.
 */
import crypto from 'crypto';
import { getRuntime } from '../runtime.js';
import { getAuditBody } from './minio-archive.js';
import { indexDocument } from './client.js';

export interface AuditIndexEsPayload {
  eventId: string;
}

export async function handleAuditIndexEs(payload: AuditIndexEsPayload): Promise<void> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  const row = await prisma.auditEvent.findUnique({
    where: { eventId: payload.eventId },
  });
  if (!row) {
    console.warn(`[audit-index-es] no audit_events row for ${payload.eventId}; ack`);
    return;
  }

  let bodyBytes: Buffer;
  try {
    bodyBytes = await getAuditBody(row.agencyId, row.eventId);
  } catch (err) {
    await recordIndexError(row.eventId, `minio: ${(err as Error).message}`);
    throw err;
  }

  const computedSha = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  if (computedSha !== row.bodySha256) {
    const msg = `body sha256 mismatch for ${row.eventId}: pg=${row.bodySha256} minio=${computedSha}`;
    await recordIndexError(row.eventId, msg);
    // Hard error — do not retry; raise as fatal job error.
    throw new Error(`[audit-index-es] FATAL ${msg}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(bodyBytes.toString('utf8'));
  } catch (err) {
    await recordIndexError(row.eventId, `parse: ${(err as Error).message}`);
    throw err;
  }

  // Add chain-level fields to the indexed doc so existing query/UI can
  // surface seq + hashes alongside the body content.
  const doc = {
    ...parsed,
    seq: row.seq.toString(),
    prevHash: row.prevHash,
    eventHash: row.eventHash,
    bodyS3Key: row.bodyS3Key,
    bodySha256: row.bodySha256,
  };

  try {
    await indexDocument(doc as unknown as { eventId: string; timestamp: string; [k: string]: unknown }, { refresh: 'false' });
  } catch (err) {
    await recordIndexError(row.eventId, `es: ${(err as Error).message}`);
    throw err;
  }

  await prisma.auditEsIndexState.update({
    where: { eventId: row.eventId },
    data: { indexedAt: new Date(), lastError: null, lastAttempt: new Date() },
  });
}

async function recordIndexError(eventId: string, msg: string): Promise<void> {
  const { prisma } = getRuntime();
  if (!prisma) return;
  try {
    await prisma.auditEsIndexState.upsert({
      where: { eventId },
      create: { eventId, attempts: 1, lastError: msg.slice(0, 1024), lastAttempt: new Date() },
      update: {
        attempts: { increment: 1 },
        lastError: msg.slice(0, 1024),
        lastAttempt: new Date(),
      },
    });
  } catch (err) {
    console.error('[audit-index-es] failed to record lastError:', (err as Error).message);
  }
}
