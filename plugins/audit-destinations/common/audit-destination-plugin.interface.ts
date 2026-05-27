/**
 * Audit Destination Plugin Interface — runtime types (shared submodule).
 *
 * Only the runtime shapes live here: AuditEvent, AuditDestinationFilters,
 * SendResult. The wizard/manifest/config-field surface (React-typed,
 * UI-only) lives in the web repo's mirror file. The Bull worker imports
 * just this file via the shared submodule.
 */

// ─── Filters ─────────────────────────────────────────────────────────────────

export interface AuditDestinationFilters {
  sources: string[];                 // ['*'] or specific keys like 'google-workspace'
  minSeverity: 'info' | 'warning' | 'critical';
  excludePatterns: string[];         // event-type globs to skip
}

// ─── Runtime contract ────────────────────────────────────────────────────────

/**
 * Minimal shape of an audit event row read from PG. The Bull worker passes
 * an array of these into formatBatch; plugins must NOT depend on any field
 * not declared here.
 */
export interface AuditEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  source: string;
  actor: { id?: string; email?: string; name?: string; type?: string };
  agency: { id: string; slug?: string };
  resource?: { type?: string; id?: string; name?: string };
  context?: Record<string, unknown>;
}

export interface SendResult {
  success: boolean;
  error?: string;
  responseTimeMs?: number;
  metadata?: Record<string, unknown>;
}
