/**
 * Recurring access windows — pure resolver (shared).
 *
 * Given a schedule (RRULE or legacy JSON) + timezone + start/end times,
 * return the next N concrete windows from a reference time.
 *
 * Pure function: no DB, no side effects, no logging. Safe to call from
 * route handlers, schedulers, tests, and Bull workers.
 *
 * RRULE math delegates to `rrule.js` (DST, leap year, month-end). We never
 * hand-roll recurrence arithmetic.
 */

// `rrule` has two incompatible runtime shapes:
//   • Plain Node ESM (bull worker): named imports fail at runtime with
//     "Named export 'RRule' not found" because rrule's CJS entry is loaded.
//   • Next.js webpack production build: a prior default-import fix breaks
//     here because webpack interops the ESM entry and `rrulePkg.default`
//     is undefined.
// Namespace import works in both runtimes — named exports always land on
// the namespace object regardless of CJS/ESM interop strategy.
import * as rrulePkg from 'rrule';
import type { RRule as RRuleInstance } from 'rrule';
const { RRule, rrulestr } = rrulePkg;
type RRule = RRuleInstance;

export type DayName = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';

export interface AccessSchedule {
  days?: DayName[];
  startTime?: string;
  endTime?: string;
  timezone?: string;
}

export interface Window {
  start: string;  // ISO 8601 UTC
  end: string;    // ISO 8601 UTC
  startLocal: string;  // presentational "YYYY-MM-DDTHH:mm" in TZ
  endLocal: string;
}

export interface ResolveInput {
  rrule?: string | null;
  accessSchedule?: AccessSchedule | null;
  timezone?: string | null;
  startTime?: string | null;  // "HH:MM"
  endTime?: string | null;    // "HH:MM"
}

const DAY_TO_RRULE: Record<DayName, string> = {
  sun: 'SU', mon: 'MO', tue: 'TU', wed: 'WE', thu: 'TH', fri: 'FR', sat: 'SA',
};

const MINUTES_PER_DAY = 24 * 60;

function parseHHMM(s: string | null | undefined, fallback: number): number {
  if (!s) return fallback;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return fallback;
  return (h || 0) * 60 + (m || 0);
}

/**
 * Validate an RRULE string. Returns null on success, an error string on failure.
 */
export function validateRRule(rrule: string): string | null {
  if (!rrule || typeof rrule !== 'string') return 'empty';
  try {
    const rule = rrulestr(rrule);
    if (rule instanceof RRule) {
      const next = rule.after(new Date(0), true);
      if (!next && !rule.options.count && !rule.options.until) {
        // No occurrence and no bound → suspicious but not strictly invalid.
      }
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function buildRRule(rruleStr: string): RRule {
  const parsed = rrulestr(rruleStr) as unknown as RRule | { rrules(): RRule[] };
  if (parsed instanceof RRule) return parsed;
  const set = parsed as { rrules(): RRule[] };
  const first = set.rrules?.()[0];
  if (!first) throw new Error('RRULE set has no RRULE component');
  return first;
}

/**
 * Convert a legacy AccessSchedule to an RRULE string.
 */
export function legacyToRRule(schedule: AccessSchedule): string | null {
  if (!schedule || !schedule.days || schedule.days.length === 0) return null;
  const days = schedule.days
    .map((d) => DAY_TO_RRULE[d])
    .filter(Boolean)
    .join(',');
  if (!days) return null;
  return `FREQ=WEEKLY;BYDAY=${days}`;
}

function toLocalIso(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

function atLocalTime(dayUtc: Date, timezone: string, minutesOfDay: number): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(dayUtc);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  const y = Number(get('year'));
  const mo = Number(get('month'));
  const d = Number(get('day'));
  const hh = Math.floor(minutesOfDay / 60);
  const mm = minutesOfDay % 60;

  const guess = new Date(Date.UTC(y, mo - 1, d, hh, mm, 0, 0));
  const observedLocal = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(guess);
  const o = (t: string) => observedLocal.find((p) => p.type === t)?.value ?? '00';
  const oy = Number(o('year'));
  const omo = Number(o('month'));
  const od = Number(o('day'));
  const ohh = Number(o('hour')) % 24;
  const omm = Number(o('minute'));

  const targetUtc = Date.UTC(y, mo - 1, d, hh, mm, 0, 0);
  const observedUtc = Date.UTC(oy, omo - 1, od, ohh, omm, 0, 0);
  const offsetMs = targetUtc - observedUtc;
  return new Date(guess.getTime() + offsetMs);
}

/**
 * Resolve up to `count` windows starting at or after `from`.
 */
export function resolveWindows(
  input: ResolveInput,
  from: Date,
  count: number,
): Window[] {
  const safeCount = Math.max(0, Math.min(count | 0, 20));
  if (safeCount === 0) return [];

  const tz = input.timezone || input.accessSchedule?.timezone || 'UTC';
  const startMin = parseHHMM(input.startTime || input.accessSchedule?.startTime, 9 * 60);
  const endMin = parseHHMM(input.endTime || input.accessSchedule?.endTime, 17 * 60);

  let rruleStr = (input.rrule || '').trim();
  if (!rruleStr && input.accessSchedule) {
    rruleStr = legacyToRRule(input.accessSchedule) || '';
  }
  if (!rruleStr) return [];

  let rule: RRule;
  try {
    rule = buildRRule(rruleStr);
  } catch {
    return [];
  }

  const lookbackFrom = new Date(from.getTime() - MINUTES_PER_DAY * 60 * 1000);
  const occurrences = rule.between(
    lookbackFrom,
    new Date(from.getTime() + 365 * 2 * 86400 * 1000),
    true,
  );

  const out: Window[] = [];
  for (const occ of occurrences) {
    const start = atLocalTime(occ, tz, startMin);
    let end: Date;
    if (endMin <= startMin) {
      const nextDay = new Date(occ.getTime() + 86400 * 1000);
      end = atLocalTime(nextDay, tz, endMin);
    } else {
      end = atLocalTime(occ, tz, endMin);
    }

    if (end.getTime() <= from.getTime()) continue;

    out.push({
      start: start.toISOString(),
      end: end.toISOString(),
      startLocal: toLocalIso(start, tz),
      endLocal: toLocalIso(end, tz),
    });
    if (out.length >= safeCount) break;
  }

  return out;
}

/**
 * Is `instant` inside any window produced by the schedule?
 */
export function isInWindow(input: ResolveInput, instant: Date): boolean {
  const windows = resolveWindows(input, new Date(instant.getTime() - MINUTES_PER_DAY * 60 * 1000), 3);
  for (const w of windows) {
    const s = Date.parse(w.start);
    const e = Date.parse(w.end);
    if (instant.getTime() >= s && instant.getTime() < e) return true;
  }
  return false;
}

/**
 * Produce a one-line schedule summary for audit payloads.
 */
export function summarizeSchedule(input: ResolveInput): string {
  if (input.rrule) {
    const tz = input.timezone || 'UTC';
    const st = input.startTime || '—';
    const et = input.endTime || '—';
    return `${input.rrule} ${st}-${et} ${tz}`;
  }
  if (input.accessSchedule?.days?.length) {
    const s = input.accessSchedule;
    return `${(s.days || []).join(',')} ${s.startTime || ''}-${s.endTime || ''} ${s.timezone || 'UTC'}`.trim();
  }
  return 'no-schedule';
}
