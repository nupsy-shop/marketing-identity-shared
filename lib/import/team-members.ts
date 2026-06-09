// shared/lib/import/team-members.ts
// Ported from web lib/import/bulk-import.ts:384-514 (#1405). Loop logic
// identical; DB access changed from web getDb() (RLS auto-injects agency_id)
// to getRuntime().prisma with EXPLICIT agency_id on every query.
//
// SECURITY: the duplicate-pending-invite check below MUST carry an explicit
// `agency_id` filter. Under RLS (web) getDb() injected it automatically; raw
// prisma does NOT, so without it the duplicate check would leak across tenants.
import crypto from 'crypto';
import { getRuntime } from '../runtime.js';
import { resolveEntitlementsFromDb } from '../entitlements/resolve.js';
import { emitAuditCompleted, emitAuditFailed } from './audit.js';
import { FULL_EMAIL_REGEX, VALID_APP_ROLES } from './validation.js';
import type { ImportRow, ImportResult, ImportActor, ValidationError } from './types.js';

export async function processTeamMembers(
  rows: ImportRow[],
  actor: ImportActor,
  options: { jobId?: string } = {},
): Promise<ImportResult> {
  const { prisma } = getRuntime();
  const agencyId = actor.agencyId;

  const entitlements = await resolveEntitlementsFromDb(agencyId);
  const currentUsers = await prisma.users.findMany({
    where: { agency_id: agencyId, is_active: true },
    select: { id: true },
  });
  const maxUsers = entitlements.limits?.maxUsers ?? Infinity;

  // user_invites.source_id is a FK to identity_sources.id — not to agencies.id.
  // Resolve the local-directory source once before the loop so every row uses
  // the correct UUID. Without this, every INSERT fails the FK constraint and
  // the silent per-row catch increments `failed` without writing any rows.
  const localDirSource = await prisma.identity_sources.findFirst({
    where: { agency_id: agencyId, plugin_key: 'local-directory' },
    select: { id: true },
  });
  if (!localDirSource) {
    return {
      imported: 0,
      skipped: 0,
      failed: rows.length,
      errors: rows.map((r) => ({
        row: r._rowIndex ?? 0,
        field: null,
        message: 'Local directory identity source not configured for this agency',
      })),
    };
  }
  const sourceId = localDirSource.id;

  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const errors: ValidationError[] = [];
  let currentCount = currentUsers.length;

  try {
    for (const row of rows) {
      try {
        const email = (row.email || '').trim();
        const role = (row.role || '').trim();
        const firstName = (row.firstName || '').trim();
        const lastName = (row.lastName || '').trim();

        if (!email) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'email', message: 'email is required' });
          continue;
        }

        // Defense-in-depth: validate email format in the worker as well as the
        // route. The route rejects invalid emails before enqueueing, but the
        // worker must also catch them so that a directly-seeded job (e.g. from
        // a future migration or direct BullMQ publish) does not silently write
        // a malformed email into user_invites.
        if (!FULL_EMAIL_REGEX.test(email)) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'email', message: `invalid_email: email is not a valid email` });
          continue;
        }

        if (!role || !(VALID_APP_ROLES as readonly string[]).includes(role)) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: 'role', message: `Invalid role "${role}"` });
          continue;
        }

        // Explicit duplicate-invite guard: a second pending invite for the
        // same email is a hard failure, not a silent skip.
        // SECURITY: raw prisma does NOT auto-inject agency_id (no RLS in the
        // worker), so the agency_id filter is added explicitly here. Without
        // it the duplicate check would leak pending invites across tenants.
        const existingInvite = await prisma.user_invites.findFirst({
          where: { email, status: 'pending', agency_id: agencyId },
          select: { id: true },
        });
        if (existingInvite) {
          failed++;
          errors.push({
            row: row._rowIndex ?? 0,
            field: 'email',
            message: `A pending invite already exists for ${email}`,
            reason: 'duplicate_invite',
          });
          continue;
        }

        if (currentCount >= maxUsers) {
          failed++;
          errors.push({ row: row._rowIndex ?? 0, field: null, message: `User limit reached (${maxUsers})` });
          continue;
        }

        const displayName = [firstName, lastName].filter(Boolean).join(' ') || email.split('@')[0];

        await prisma.user_invites.create({
          data: {
            id: crypto.randomUUID(),
            agency_id: agencyId,
            source_id: sourceId,
            email,
            display_name: displayName || null,
            role: role || 'readonly',
            invited_by: actor.id || null,
            status: 'pending',
            token: crypto.randomUUID(),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });

        currentCount++;
        imported++;
      } catch (err) {
        failed++;
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ row: row._rowIndex ?? 0, field: null, message });
      }
    }
    const result = { imported, skipped, failed, errors };
    if (options.jobId) {
      await emitAuditCompleted({ actor, jobId: options.jobId, importType: 'team_members', result, total: rows.length });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (options.jobId) {
      await emitAuditFailed({
        actor,
        jobId: options.jobId,
        importType: 'team_members',
        processed: imported + skipped + failed,
        total: rows.length,
        error: message,
      });
    }
    throw err;
  }
}
