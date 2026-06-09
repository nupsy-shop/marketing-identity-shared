// shared/lib/import/access-requests.ts
// Ported from web lib/import/bulk-import.ts:259-380 (#1405 P4). Logic identical;
// DB access changed from web getDb()/db.* (RLS auto-injects agency_id) to
// getRuntime().prisma with EXPLICIT agency_id on every create. Platform
// resolution uses getConnectedPlatformsByKey() instead of ensurePluginsLoaded()
// + PluginRegistry — see ./connected-platforms.ts. Every create replicates the
// exact column set stamped by lib/db/access-requests.ts createAccessRequest /
// createAccessRequestItem, substituting actor.agencyId for getTenantId().
import crypto from 'crypto';
import { getRuntime } from '../runtime.js';
import { emitAuditCompleted, emitAuditFailed } from './audit.js';
import { getConnectedPlatformsByKey } from './connected-platforms.js';
import type { ImportRow, ImportResult, ImportActor, ValidationError } from './types.js';

export async function processAccessRequests(
  rows: ImportRow[],
  actor: ImportActor,
  options: { jobId?: string } = {},
): Promise<ImportResult> {
  const { prisma } = getRuntime();
  const agencyId = actor.agencyId;

  const clients = await prisma.clients.findMany({
    where: { agency_id: agencyId },
    select: { id: true, name: true },
  });
  const clientsByName = new Map(
    clients.map((c: { id: string; name: string | null }) => [(c.name || '').toLowerCase(), c.id]),
  );
  const clientsById = new Map(
    clients.map((c: { id: string; name: string | null }) => [c.id, c.id]),
  );

  const platformsByKey = await getConnectedPlatformsByKey(agencyId);

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: ValidationError[] = [];

  try {
    for (const row of rows) {
      try {
        const clientKey = (row.clientName || row.clientId || '').trim();
        const platformKey = (row.platformKey || '').trim();
        const role = (row.role || '').trim();
        const accessPattern = (row.accessPattern || 'NAMED_INVITE').trim();
        const notes = (row.notes || '').trim();

        const clientId =
          clientsByName.get(clientKey.toLowerCase()) ||
          clientsById.get(clientKey) ||
          row.clientId;
        if (!clientId) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'clientName', message: `Client "${clientKey}" not found` });
          continue;
        }

        const platform = platformsByKey.get(platformKey);
        if (!platform) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'platformKey', message: `Platform "${platformKey}" not connected` });
          continue;
        }

        if (!role) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'role', message: 'role is required' });
          continue;
        }

        const requestId = crypto.randomUUID();
        // Mirror lib/db/access-requests.ts:createAccessRequest column set,
        // substituting explicit agency_id for getTenantId().
        await prisma.access_requests.create({
          data: {
            id: requestId,
            clientId,
            agency_id: agencyId,
            token: crypto.randomUUID(),
            notes: (notes || `Bulk import - ${platformKey} ${role}`) || null,
            requestedBy: actor.id || null,
            matched_policy_id: null,
            matched_policy_action_type: null,
            policy_evaluation_at: null,
            updatedAt: new Date(),
          },
        });

        let expiresAt: Date | null = null;
        const duration = (row.duration || '').trim();
        if (duration && duration !== 'permanent') {
          const days = parseInt(duration, 10);
          if (!isNaN(days)) {
            expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
          } else {
            const parsed = Date.parse(duration);
            if (!isNaN(parsed)) expiresAt = new Date(parsed);
          }
        }

        // Mirror lib/db/access-requests.ts:createAccessRequestItem column set,
        // substituting explicit agency_id for getTenantId(). The original
        // processAccessRequests passed only id/accessRequestId/platformId/
        // itemType/accessPattern/patternLabel/role/assetName/status/expiresAt;
        // every other column took its createAccessRequestItem default.
        await prisma.access_request_items.create({
          data: {
            id: crypto.randomUUID(),
            accessRequestId: requestId,
            agency_id: agencyId,
            platformId: platform.platformId,
            itemType: accessPattern,
            accessPattern: accessPattern || null,
            patternLabel: accessPattern.replace(/_/g, ' ').toLowerCase() || null,
            role,
            assetName: null,
            identityPurpose: null,
            humanIdentityStrategy: null,
            resolvedIdentity: null,
            agencyGroupEmail: null,
            // agencyData / pamConfig / accessSchedule are Json? columns. The web
            // layer mapped their undefined → Prisma.JsonNull; under Prisma 7 a
            // plain `null` on a nullable Json field at the top of create.data is
            // REJECTED at runtime (must be Prisma.JsonNull/DbNull). The shared
            // module can't import the Prisma namespace (registry-free, `any`
            // runtime), so we OMIT these — Prisma writes SQL NULL, matching the
            // bulk path which never has real values for them.
            pamOwnership: null,
            clientInstructions: null,
            status: 'pending',
            risk_level: 'low',
            required_approver_type: null,
            expiresAt: expiresAt || null,
            rrule: null,
            updatedAt: new Date(),
          },
        });

        imported++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ row: row._rowIndex ?? 0, field: null, message });
      }
    }
    const result = { imported, skipped, failed, errors };
    if (options.jobId) {
      await emitAuditCompleted({ actor, jobId: options.jobId, importType: 'access_requests', result, total: rows.length });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.jobId) {
      await emitAuditFailed({
        actor,
        jobId: options.jobId,
        importType: 'access_requests',
        processed: imported + skipped + failed,
        total: rows.length,
        error: message,
      });
    }
    throw err;
  }
}
