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
  // Minimal structural check: exactly one @, non-empty local + domain w/ a dot.
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
