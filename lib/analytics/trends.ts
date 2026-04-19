/**
 * Access-analytics 90-day trend rollup (#59).
 *
 * Pure function. Reconstructs daily buckets from the audit log. Events with
 * eventType `access.granted` increment the day's grantCount and mark the
 * user as touched; `access.revoked` decrements grantCount but does NOT
 * un-mark the user (a user who was granted and then revoked on the same
 * day still counted as a unique user that day).
 *
 * `averageRiskScore` is carried per day when supplied via the
 * `riskSnapshotsByDay` argument (caller-side lookup). Absent → null and
 * the UI renders a dash — the snapshot table is a cache, not source of
 * truth.
 *
 * Bucketing is UTC-day. Per-agency timezones are intentionally NOT used:
 * consistent cross-agency bucketing is more valuable than local calendars.
 */

export interface TrendAuditEvent {
  /** ISO timestamp. */
  timestamp: string;
  /** `access.granted` | `access.revoked` (anything else is ignored). */
  eventType: string;
  /** Subject user of the event (for unique-user counting). */
  userId?: string | null;
}

export interface TrendPoint {
  /** UTC day bucket (YYYY-MM-DD). */
  day: string;
  /** Net grants applied on this day (granted minus revoked). */
  grantCount: number;
  /** Distinct userIds that appear on this day's events. */
  uniqueUserCount: number;
  /** Optional per-day average risk score from the risk snapshot (null when unknown). */
  averageRiskScore: number | null;
}

export interface BuildTrendsArgs {
  events: TrendAuditEvent[];
  /** Number of daily points to emit (default 90). */
  days?: number;
  /** Anchor day — inclusive end of the window. Defaults to today (UTC). */
  endDay?: Date;
  /** Optional per-day risk snapshot (YYYY-MM-DD → average risk score). */
  riskSnapshotsByDay?: Record<string, number>;
}

/** Return the UTC day bucket for a given Date, formatted YYYY-MM-DD. */
export function toUtcDayKey(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildTrends(args: BuildTrendsArgs): TrendPoint[] {
  const {
    events,
    days = 90,
    endDay = new Date(),
    riskSnapshotsByDay = {},
  } = args;

  const endKey = toUtcDayKey(endDay);
  const anchor = new Date(endKey + 'T00:00:00Z');

  const dayKeys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(anchor);
    d.setUTCDate(d.getUTCDate() - i);
    dayKeys.push(toUtcDayKey(d));
  }

  const byDay: Map<string, { granted: number; revoked: number; users: Set<string> }> = new Map();
  for (const key of dayKeys) byDay.set(key, { granted: 0, revoked: 0, users: new Set() });

  for (const ev of events) {
    if (!ev || !ev.timestamp) continue;
    const key = toUtcDayKey(ev.timestamp);
    const bucket = byDay.get(key);
    if (!bucket) continue;

    if (ev.eventType === 'access.granted') {
      bucket.granted += 1;
      if (ev.userId) bucket.users.add(ev.userId);
    } else if (ev.eventType === 'access.revoked') {
      bucket.revoked += 1;
      if (ev.userId) bucket.users.add(ev.userId);
    }
  }

  return dayKeys.map((day) => {
    const b = byDay.get(day)!;
    const avg = riskSnapshotsByDay[day];
    return {
      day,
      grantCount: b.granted - b.revoked,
      uniqueUserCount: b.users.size,
      averageRiskScore: typeof avg === 'number' ? avg : null,
    };
  });
}
