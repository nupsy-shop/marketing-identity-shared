/**
 * Per-destination event filter evaluator.
 *
 * Used by the audit-forward Bull processor (Plan 4) before dispatching a batch
 * to any destination, and by the web-side "Send test event" path so the test
 * event respects the same filter semantics.
 */

import type {
  AuditEvent,
  AuditDestinationFilters,
} from './audit-destination-plugin.interface.js';

const SEVERITY_RANK: Record<AuditEvent['severity'], number> = {
  info: 0,
  warning: 1,
  critical: 2,
};

/**
 * Returns true if `event` passes ALL of the destination's filters:
 *   - source is in `filters.sources` (or sources is `['*']`)
 *   - severity rank >= minSeverity rank
 *   - event.eventType does not match any glob in excludePatterns
 *
 * Glob support is intentionally minimal: a trailing `*` matches any suffix
 * (e.g. `admin.*` matches `admin.client.created`). A bare pattern requires
 * exact match. No other glob features.
 */
export function matchesFilters(event: AuditEvent, filters: AuditDestinationFilters): boolean {
  // Source check
  if (!filters.sources.includes('*') && !filters.sources.includes(event.source)) {
    return false;
  }

  // Severity check
  if (SEVERITY_RANK[event.severity] < SEVERITY_RANK[filters.minSeverity]) {
    return false;
  }

  // Exclude patterns
  for (const pattern of filters.excludePatterns) {
    if (matchesGlob(event.eventType, pattern)) {
      return false;
    }
  }

  return true;
}

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}
