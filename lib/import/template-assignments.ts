// shared/lib/import/template-assignments.ts
// Ported from web lib/import/bulk-import.ts:518-639 (#1405 P5). Logic identical;
// DB access changed from web getDb()/db.* (RLS auto-injects agency_id) to
// getRuntime().prisma with EXPLICIT agency_id on every create.
//
// Role templates come from agency_settings.role_templates (Prisma field
// `role_templates`, type Json?). The web getAgencySettings mapped
// row.role_templates → settings.roleTemplates; here we read the raw column.
// A template has shape { key?/id?, label?, platformRoles: [{ platformKey,
// roleKey?/role? }] } (see web bulk-import.ts iteration). Platform resolution
// uses getConnectedPlatformsByKey() instead of ensurePluginsLoaded() +
// PluginRegistry — see ./connected-platforms.ts. Create column sets mirror
// access-requests.ts (canonical createAccessRequest/createAccessRequestItem
// shapes), substituting actor.agencyId for getTenantId(). Json? columns
// (agencyData/pamConfig/accessSchedule) are OMITTED, never `null` — Prisma 7
// rejects plain null on nullable Json at create.data top-level.
import crypto from 'crypto';
import { getRuntime } from '../runtime.js';
import { emitAuditCompleted, emitAuditFailed } from './audit.js';
import { getConnectedPlatformsByKey } from './connected-platforms.js';
import type { ImportRow, ImportResult, ImportActor, ValidationError } from './types.js';

export async function processTemplateAssignments(
  rows: ImportRow[],
  actor: ImportActor,
  options: { jobId?: string } = {},
): Promise<ImportResult> {
  const { prisma } = getRuntime();
  const agencyId = actor.agencyId;

  const settings = await prisma.agency_settings.findFirst({
    where: { agency_id: agencyId },
    select: { role_templates: true },
  });
  const templates = (settings?.role_templates as Array<Record<string, unknown>>) || [];
  const templatesByKey = new Map(
    templates.map((t) => [(t.key || t.id) as string, t]),
  );

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
        // Gap #13: resolve client by clientName OR clientId (parity with access_requests).
        const clientKey = (row.clientName || row.clientId || '').trim();
        const templateKey = (row.templateKey || '').trim();

        const clientId =
          clientsByName.get(clientKey.toLowerCase()) ||
          clientsById.get(clientKey) ||
          (row.clientId ? (row.clientId as string) : undefined);
        if (!clientId) {
          failed++;
          errors.push({
            row: row._rowIndex ?? 0,
            field: 'clientName',
            message: `Client "${clientKey}" not found`,
            reason: 'client_not_found',
          });
          continue;
        }

        const template = templatesByKey.get(templateKey);
        if (!template) {
          failed++;
          errors.push({
            row: row._rowIndex ?? 0,
            field: 'templateKey',
            message: `Template "${templateKey}" not found`,
            reason: 'template_not_found',
          });
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
            notes: `Bulk template assignment: ${(template.label as string) || templateKey}`,
            requestedBy: actor.id || null,
            matched_policy_id: null,
            matched_policy_action_type: null,
            policy_evaluation_at: null,
            updatedAt: new Date(),
          },
        });

        for (const pr of ((template.platformRoles as Array<Record<string, unknown>>) || [])) {
          const platform = platformsByKey.get(pr.platformKey as string);
          if (!platform) continue;

          // Mirror lib/db/access-requests.ts:createAccessRequestItem column set,
          // substituting explicit agency_id for getTenantId(). The original
          // processTemplateAssignments passed itemType/accessPattern 'NAMED_INVITE',
          // patternLabel 'named invite', role pr.roleKey||pr.role, status 'pending';
          // every other column took its createAccessRequestItem default. Json?
          // columns (agencyData/pamConfig/accessSchedule) OMITTED, never null.
          await prisma.access_request_items.create({
            data: {
              id: crypto.randomUUID(),
              accessRequestId: requestId,
              agency_id: agencyId,
              platformId: platform.platformId,
              itemType: 'NAMED_INVITE',
              accessPattern: 'NAMED_INVITE',
              patternLabel: 'named invite',
              role: (pr.roleKey || pr.role || '') as string,
              assetName: null,
              identityPurpose: null,
              humanIdentityStrategy: null,
              resolvedIdentity: null,
              agencyGroupEmail: null,
              pamOwnership: null,
              clientInstructions: null,
              status: 'pending',
              risk_level: 'low',
              required_approver_type: null,
              expiresAt: null,
              rrule: null,
              updatedAt: new Date(),
            },
          });
        }

        imported++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ row: row._rowIndex ?? 0, field: null, message });
      }
    }
    const result = { imported, skipped, failed, errors };
    if (options.jobId) {
      await emitAuditCompleted({ actor, jobId: options.jobId, importType: 'template_assignments', result, total: rows.length });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.jobId) {
      await emitAuditFailed({
        actor,
        jobId: options.jobId,
        importType: 'template_assignments',
        processed: imported + skipped + failed,
        total: rows.length,
        error: message,
      });
    }
    throw err;
  }
}
