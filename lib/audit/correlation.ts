import type { PrismaClient } from '@prisma/client';

/**
 * PAM session-recording correlation helpers.
 *
 * These compute the DERIVED correlation index values written to
 * audit_events_mirror (identity_id / occurred_at / attribution). They never
 * touch the immutable audit body. Resolution is FAIL-CLOSED: an ambiguous or
 * non-email actor yields NO identity, so a recording omits an external action
 * rather than attributing it to the wrong identity.
 */

const NON_EMAIL_SENTINELS = new Set(['system', 'unknown', '']);

/** True only for a structurally-valid, non-sentinel email we may resolve. */
export function isResolvableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const v = email.trim().toLowerCase();
  if (NON_EMAIL_SENTINELS.has(v)) return false;
  if (/\s/.test(v)) return false; // reject internal whitespace (e.g. "user @x.com")
  // Heuristic structural check (NOT RFC 5322): exactly one @, non-empty local +
  // domain with a dot. False positives are absorbed fail-closed by the resolver.
  const at = v.indexOf('@');
  if (at <= 0 || at !== v.lastIndexOf('@')) return false;
  const domain = v.slice(at + 1);
  return domain.includes('.') && !domain.startsWith('.') && !domain.endsWith('.');
}

/**
 * The platform's own event time (NOT ingest time). The window query depends on
 * this: grants are ~300s but ingestion lags ~10min, so filtering on ingest time
 * would place every external action outside the grant window. Adapters carry the
 * platform time under different context keys; fall back to capturedAt when absent
 * (e.g. Google Workspace, whose adapter emits no explicit event time — this makes
 * GWS windowed attribution ingest-time-precise only; documented limitation).
 */
export function deriveOccurredAt(
  context: Record<string, unknown> | null | undefined,
  capturedAt: Date,
): Date {
  const candidates = [context?.eventTime, context?.published, context?.occurredAt];
  for (const c of candidates) {
    if (typeof c === 'string' || c instanceof Date) {
      const d = new Date(c as string);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return capturedAt;
}

/** 'bound' = AccessHive-mediated (grant known); 'windowed' = external by identity+time. */
export function deriveAttribution(
  sessionGrantId: string | null,
  identityId: string | null,
): 'bound' | 'windowed' | null {
  if (sessionGrantId) return 'bound';
  if (identityId) return 'windowed';
  return null;
}

/**
 * Resolve a platform actor email to an integration_identities.id.
 * Agency-scoped, fail-closed: returns null unless EXACTLY ONE identity in the
 * agency has identifier === email. Ambiguity (>=2) or non-email -> null, so the
 * recording omits the action rather than guessing.
 */
export async function resolveIdentityIdByEmail(
  prisma: PrismaClient,
  agencyId: string,
  email: string | null | undefined,
): Promise<string | null> {
  if (!isResolvableEmail(email)) return null;
  const rows = await prisma.integration_identities.findMany({
    where: {
      agency_id: agencyId,
      identifier: { equals: (email as string).trim(), mode: 'insensitive' },
    },
    select: { id: true },
    take: 2,
  });
  return rows.length === 1 ? rows[0].id : null;
}
