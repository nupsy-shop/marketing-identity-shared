// shared/lib/import/clients.ts
// Ported from web lib/import/bulk-import.ts:182-258 (#1405). Logic identical;
// DB access changed from web getDb() (RLS auto-injects agency_id) to
// getRuntime().prisma with EXPLICIT agency_id on every query.
import crypto from 'crypto';
import { getRuntime } from '../runtime.js';
import { emitAuditCompleted, emitAuditFailed } from './audit.js';
import type { ImportRow, ImportResult, ImportActor, ValidationError } from './types.js';

export async function processClients(
  rows: ImportRow[],
  actor: ImportActor,
  options: { jobId?: string } = {},
): Promise<ImportResult> {
  const { prisma } = getRuntime();
  const agencyId = actor.agencyId;

  const existing = await prisma.clients.findMany({
    where: { agency_id: agencyId },
    select: { name: true },
  });
  const existingNames = new Set(
    existing.map((c: { name: string | null }) => (c.name || '').toLowerCase()),
  );

  let imported = 0, skipped = 0, failed = 0;
  const errors: ValidationError[] = [];

  try {
    for (const row of rows) {
      try {
        const name = (row.name || '').trim();
        if (!name) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'name', message: 'name is required' });
          continue;
        }
        if (existingNames.has(name.toLowerCase())) {
          skipped++;
          errors.push({ row: row._rowIndex ?? 0, field: 'name', message: `Client "${name}" already exists`, reason: 'duplicate_name' });
          continue;
        }
        await prisma.clients.create({
          data: {
            id: crypto.randomUUID(),
            name,
            email: (row.contactEmail || '').trim(),
            domains: [],
            tags: [],
            status: 'active',
            metadata: {
              contactName: (row.contactName || '').trim() || null,
              website: (row.website || '').trim() || null,
              notes: (row.notes || '').trim() || null,
              importSource: 'bulk_csv',
            },
            agency_id: agencyId,
            updatedAt: new Date(),
          },
        });
        existingNames.add(name.toLowerCase());
        imported++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ row: row._rowIndex ?? 0, field: null, message });
      }
    }
    const result = { imported, skipped, failed, errors };
    if (options.jobId) {
      await emitAuditCompleted({ actor, jobId: options.jobId, importType: 'clients', result, total: rows.length });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.jobId) {
      await emitAuditFailed({ actor, jobId: options.jobId, importType: 'clients', processed: imported + skipped + failed, total: rows.length, error: message });
    }
    throw err;
  }
}
