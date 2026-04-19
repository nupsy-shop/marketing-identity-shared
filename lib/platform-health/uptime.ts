/**
 * Platform Health — 30-day uptime computation.
 *
 * Source of truth: `identity.source.state_change` events in Elasticsearch.
 * No new time-series table (invariant — would drift from the audit log).
 *
 * Algorithm:
 *   1. Query state_change events for (agencyId, sourceId) in [windowStart, now].
 *   2. Walk the transitions in chronological order, accumulating minutes spent
 *      in `connected`.
 *   3. Divide by total minutes. "unknown" when retention is shorter than the
 *      requested window or when there are zero events AND the source's own
 *      state is unknown.
 *
 * The math helper is split from the ES fetch so the reducer is
 * unit-testable without ES.
 */

import { UPTIME_WINDOW_DAYS } from './types.js';

export interface StateChangeEvent {
  timestamp: Date;
  previousState: string | null;
  newState: string;
}

export interface UptimeInput {
  windowStart: Date;
  windowEnd: Date;
  /** Chronologically-ordered transitions in the window. */
  events: StateChangeEvent[];
  /** The source's state at windowStart (if known from the earliest event
   *  preceding the window or the current state if no events exist). */
  stateAtWindowStart?: string | null;
}

export interface UptimeResult {
  /** 0–100 percentage, or null when insufficient data. */
  uptimePct: number | null;
  /** Raw minutes spent in `connected` over the window. */
  connectedMinutes: number;
  /** Total minutes in the window. */
  windowMinutes: number;
  /** True when uptime was not calculable. */
  unknown: boolean;
  /** Reason for unknown (surfaced in API responses for debugging). */
  reason?: string;
}

export function reduceUptime(input: UptimeInput): UptimeResult {
  const windowMs = input.windowEnd.getTime() - input.windowStart.getTime();
  const windowMinutes = Math.max(1, Math.round(windowMs / 60000));

  if (input.events.length === 0 && !input.stateAtWindowStart) {
    return {
      uptimePct: null,
      connectedMinutes: 0,
      windowMinutes,
      unknown: true,
      reason: 'no state_change events in window',
    };
  }

  let connectedMs = 0;
  let cursorMs = input.windowStart.getTime();
  let currentState = input.stateAtWindowStart ?? input.events[0]?.previousState ?? null;

  for (const ev of input.events) {
    const evMs = Math.max(cursorMs, ev.timestamp.getTime());
    if (currentState === 'connected') {
      connectedMs += evMs - cursorMs;
    }
    cursorMs = evMs;
    currentState = ev.newState;
  }

  if (currentState === 'connected') {
    connectedMs += input.windowEnd.getTime() - cursorMs;
  }

  const connectedMinutes = Math.max(0, Math.round(connectedMs / 60000));
  const pct = (connectedMinutes / windowMinutes) * 100;

  return {
    uptimePct: Math.max(0, Math.min(100, pct)),
    connectedMinutes,
    windowMinutes,
    unknown: false,
  };
}

/**
 * Resolve the effective uptime window given the agency retention ceiling.
 *
 * - A 30-day request against a 7-day retention tier returns a 7-day window
 *   with `unknown = true` (per the spec: "unknown" when retention < 30d).
 * - A 90-day request clamps to the retention ceiling with `clamped = true`.
 */
export function resolveWindow(
  now: Date,
  requestedDays: number,
  retentionDays: number | null,
): {
  windowStart: Date;
  windowEnd: Date;
  windowDays: number;
  clamped: boolean;
  shortRetention: boolean;
} {
  const requested = requestedDays || UPTIME_WINDOW_DAYS;
  const effectiveDays = retentionDays && retentionDays < requested ? retentionDays : requested;
  const clamped = effectiveDays < requested;
  const shortRetention = retentionDays !== null && retentionDays < UPTIME_WINDOW_DAYS;

  return {
    windowStart: new Date(now.getTime() - effectiveDays * 24 * 60 * 60 * 1000),
    windowEnd: new Date(now.getTime()),
    windowDays: effectiveDays,
    clamped,
    shortRetention,
  };
}
