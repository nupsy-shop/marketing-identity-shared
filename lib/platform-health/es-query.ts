/**
 * Platform Health — ES query helpers (thin wrapper).
 *
 * Never exported to the UI. Always scoped by agency_id (invariant).
 */

import { queryAuditEvents } from '../audit/query.js';
import type { StateChangeEvent } from './uptime.js';
import type { RecentTransition } from './debounce.js';

const EVENT_TYPE_STATE_CHANGE = 'identity.source.state_change';

/**
 * Fetch state_change events for a single source over a window.
 * Returns them in chronological order (oldest → newest).
 */
export async function fetchStateChangesForSource(
  agencyId: string,
  sourceId: string,
  from: Date,
  to: Date,
): Promise<StateChangeEvent[]> {
  if (!agencyId) throw new Error('agencyId required');
  if (!sourceId) throw new Error('sourceId required');

  const result = await queryAuditEvents({
    agencyId,
    eventType: EVENT_TYPE_STATE_CHANGE,
    resourceType: 'identity_source',
    resourceId: sourceId,
    dateFrom: from,
    dateTo: to,
    sortField: 'timestamp',
    sortOrder: 'asc',
    limit: 200,
  });

  return result.data.map((ev) => {
    const ctx = (ev.context as Record<string, unknown> | undefined) ?? {};
    return {
      timestamp: new Date(ev.timestamp),
      previousState: (ctx.previousState as string | null) ?? null,
      newState: (ctx.newState as string) ?? 'unknown',
    };
  });
}

/**
 * Fetch the last N state_change emits for a source — used by the
 * 5-minute debounce check before firing a notification.
 */
export async function fetchRecentTransitions(
  agencyId: string,
  sourceId: string,
  sinceMs: number,
  now: Date = new Date(),
): Promise<RecentTransition[]> {
  const from = new Date(now.getTime() - sinceMs);
  const result = await queryAuditEvents({
    agencyId,
    eventType: EVENT_TYPE_STATE_CHANGE,
    resourceType: 'identity_source',
    resourceId: sourceId,
    dateFrom: from,
    dateTo: now,
    sortField: 'timestamp',
    sortOrder: 'desc',
    limit: 20,
  });

  return result.data.map((ev) => {
    const ctx = (ev.context as Record<string, unknown> | undefined) ?? {};
    return {
      emittedAt: new Date(ev.timestamp),
      newState: (ctx.newState as string) ?? 'unknown',
    };
  });
}
