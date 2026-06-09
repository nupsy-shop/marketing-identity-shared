// shared/lib/import/audit.ts
// Bulk-import audit-emit helpers, moved from web lib/import/bulk-import.ts so
// both the web app and the bull worker share them.

import { publishAuditEvent } from '../audit/publisher.js';
import { getRuntime } from '../runtime.js';
import type { ImportActor, ImportType, ImportResult } from './types.js';

// ─── Audit helpers ──────────────────────────────────────────────────────────

/**
 * Emit BULK_IMPORT_COMPLETED / BULK_IMPORT_FAILED. We deliberately DO NOT
 * include row contents in the audit payload — only type, counts, and jobId.
 * PII-bearing row contents (emails, names, notes) are never written to audit.
 */
export async function emitAuditCompleted(params: {
  actor: ImportActor;
  jobId: string;
  importType: ImportType;
  result: ImportResult;
  total: number;
}): Promise<void> {
  const { logger } = getRuntime();
  const { actor, jobId, importType, result, total } = params;
  try {
    await publishAuditEvent({
      eventType: 'admin.bulk_import.completed',
      source: 'accesshive',
      actor: {
        id: actor.id,
        email: actor.email,
        type: 'user',
        ip: null,
      },
      agency: { id: actor.agencyId, slug: actor.agencySlug || null },
      context: {
        jobId,
        type: importType,
        total,
        imported: result.imported,
        skipped: result.skipped,
        failed: result.failed,
        errorCount: result.errors.length,
      },
    });
  } catch (err) {
    logger.error('[BulkImport] Failed to emit BULK_IMPORT_COMPLETED', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function emitAuditFailed(params: {
  actor: ImportActor;
  jobId: string;
  importType: ImportType;
  processed: number;
  total: number;
  error: string;
}): Promise<void> {
  const { logger } = getRuntime();
  const { actor, jobId, importType, processed, total, error } = params;
  // Sanitize aggressively: error.message frequently contains row contents
  // (Prisma constraint errors interpolate field values; validation errors
  // include the offending row identifier). Earlier `split(':')[0]` did
  // not reliably strip these because some Prisma messages embed the
  // value BEFORE the first colon (e.g. "Could not create row with name
  // 'tag-xyz': ..."). Replace with a hard whitelist match against the
  // first whitespace-separated token, which is the canonical class-like
  // identifier in well-formed Error.toString() output. Anything not
  // matching the allowlist falls back to 'Error'.
  const firstToken = (error.split(/\s/)[0] ?? '').replace(/[^A-Za-z]/g, '');
  const errorClass =
    firstToken && firstToken.length <= 64 && /^[A-Z][A-Za-z]+$/.test(firstToken)
      ? firstToken
      : 'Error';
  try {
    await publishAuditEvent({
      eventType: 'admin.bulk_import.failed',
      source: 'accesshive',
      severity: 'warning',
      actor: {
        id: actor.id,
        email: actor.email,
        type: 'user',
        ip: null,
      },
      agency: { id: actor.agencyId, slug: actor.agencySlug || null },
      context: { jobId, type: importType, processed, total, errorClass },
    });
  } catch (err) {
    logger.error('[BulkImport] Failed to emit BULK_IMPORT_FAILED', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
