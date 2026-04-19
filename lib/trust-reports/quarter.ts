/**
 * Quarter math helpers for trust reports (shared port of #57).
 *
 * The quarterly scheduler covers the PRIOR complete calendar quarter.
 * Running on Apr 1 returns { start: Jan 1, end: Mar 31 }.
 *
 * Pure functions — unit-testable with frozen-time fixtures. No imports
 * from the host; safe to call from worker or web scheduler.
 */

export interface Quarter {
  /** Inclusive start date, 00:00:00 UTC. */
  start: Date;
  /** Inclusive end date at 23:59:59.999 UTC (the last instant of the quarter). */
  end: Date;
  /** ISO date (YYYY-MM-DD) of the start — matches the unique-log key. */
  startDate: string;
  /** ISO date of the end. */
  endDate: string;
  /** Human label, e.g. "Q1 2026". */
  label: string;
}

/**
 * Return the prior complete calendar quarter relative to `now`.
 *
 * Examples (all in UTC):
 *   now = 2026-04-01 06:00 → Q1 2026 (Jan 1 – Mar 31)
 *   now = 2026-04-18       → Q1 2026 (Jan 1 – Mar 31)
 *   now = 2026-01-15       → Q4 2025 (Oct 1 – Dec 31)
 */
export function priorQuarter(now: Date = new Date()): Quarter {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-11

  // Current quarter index in `year` (0=Q1, 1=Q2, 2=Q3, 3=Q4).
  const currentQ = Math.floor(month / 3);

  let priorYear = year;
  let priorQ = currentQ - 1;
  if (priorQ < 0) {
    priorQ = 3;
    priorYear = year - 1;
  }

  const startMonth = priorQ * 3;
  const start = new Date(Date.UTC(priorYear, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(priorYear, startMonth + 3, 0, 23, 59, 59, 999));

  return {
    start,
    end,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    label: `Q${priorQ + 1} ${priorYear}`,
  };
}

/**
 * Return the CURRENT in-progress quarter. Used only for the preview endpoint
 * so operators can see what the next report will look like.
 */
export function currentQuarter(now: Date = new Date()): Quarter {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const q = Math.floor(month / 3);
  const startMonth = q * 3;
  const start = new Date(Date.UTC(year, startMonth, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, startMonth + 3, 0, 23, 59, 59, 999));
  return {
    start,
    end,
    startDate: toIsoDate(start),
    endDate: toIsoDate(end),
    label: `Q${q + 1} ${year}`,
  };
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
