/**
 * Prisma read/write helpers for the access_analytics_snapshots cache (#59).
 *
 * All reads and writes are agency-scoped: the caller MUST pass `agencyId`
 * on every call. Runtime services (prisma) come from getRuntime().
 *
 * Dashboard reads go through `readLatestConcentration` / `readTrendSeries`;
 * they NEVER trigger a recompute.
 */

import { getRuntime } from '../runtime.js';
import type { ConcentrationCell } from './concentration.js';
import type { TrendPoint } from './trends.js';

export type SnapshotKind = 'concentration' | 'blindspot' | 'trend';

export interface ConcentrationSnapshot {
  agencyId: string;
  capturedAt: Date;
  totalUsersInAgency: number;
  cells: ConcentrationCell[];
}

export interface TrendSnapshot {
  agencyId: string;
  capturedAt: Date;
  series: TrendPoint[];
}

/** Serialize a Date to the UTC-day string used as the snapshot idempotency key. */
function utcDayDate(d: Date): Date {
  const iso = d.toISOString().slice(0, 10);
  return new Date(iso + 'T00:00:00.000Z');
}

/**
 * Upsert a batch of concentration cells for the given agency. Within
 * the same UTC day the existing row is overwritten (idempotent — the
 * warmer can be re-run without duplicating history).
 */
export async function writeConcentrationSnapshot(args: {
  agencyId: string;
  totalUsersInAgency: number;
  cells: ConcentrationCell[];
  capturedAt?: Date;
}): Promise<void> {
  const { prisma } = getRuntime();
  const capturedAt = args.capturedAt ?? new Date();
  const dayBucket = utcDayDate(capturedAt);

  for (const cell of args.cells) {
    const key = `${cell.platformKey}:${cell.roleCategory}`;
    await prisma.access_analytics_snapshots.upsert({
      where: {
        idx_aas_agency_kind_key_day: {
          agency_id: args.agencyId,
          kind: 'concentration',
          key,
          captured_at_day: dayBucket,
        },
      } as never,
      create: {
        agency_id: args.agencyId,
        kind: 'concentration',
        key,
        captured_at: capturedAt,
        captured_at_day: dayBucket,
        payload: {
          platformKey: cell.platformKey,
          roleCategory: cell.roleCategory,
          userCount: cell.userCount,
          concentrationScore: cell.concentrationScore,
          formula: cell.formula,
          totalUsersInAgency: args.totalUsersInAgency,
        } as unknown as object,
      },
      update: {
        captured_at: capturedAt,
        payload: {
          platformKey: cell.platformKey,
          roleCategory: cell.roleCategory,
          userCount: cell.userCount,
          concentrationScore: cell.concentrationScore,
          formula: cell.formula,
          totalUsersInAgency: args.totalUsersInAgency,
        } as unknown as object,
      },
    });
  }
}

/**
 * Upsert one trend row per UTC day (90 days total). Same idempotency
 * property: re-running on the same UTC day overwrites rows.
 */
export async function writeTrendSnapshot(args: {
  agencyId: string;
  series: TrendPoint[];
  capturedAt?: Date;
}): Promise<void> {
  const { prisma } = getRuntime();
  const capturedAt = args.capturedAt ?? new Date();

  for (const point of args.series) {
    const dayBucket = new Date(point.day + 'T00:00:00.000Z');
    await prisma.access_analytics_snapshots.upsert({
      where: {
        idx_aas_agency_kind_key_day: {
          agency_id: args.agencyId,
          kind: 'trend',
          key: point.day,
          captured_at_day: dayBucket,
        },
      } as never,
      create: {
        agency_id: args.agencyId,
        kind: 'trend',
        key: point.day,
        captured_at: capturedAt,
        captured_at_day: dayBucket,
        payload: point as unknown as object,
      },
      update: {
        captured_at: capturedAt,
        payload: point as unknown as object,
      },
    });
  }
}

/**
 * Return the latest concentration cells for the given agency.
 */
export async function readLatestConcentration(agencyId: string): Promise<ConcentrationSnapshot | null> {
  const { prisma } = getRuntime();
  const rows = await prisma.access_analytics_snapshots.findMany({
    where: { agency_id: agencyId, kind: 'concentration' },
    orderBy: { captured_at: 'desc' },
    take: 500,
  });
  if (rows.length === 0) return null;

  const latestDay: Date = rows[0].captured_at_day;
  const latestRows = rows.filter(
    (r: { captured_at_day: Date }) => r.captured_at_day.getTime() === latestDay.getTime(),
  );

  const cells: ConcentrationCell[] = [];
  let totalUsersInAgency = 0;
  let capturedAt: Date = rows[0].captured_at;
  for (const r of latestRows) {
    const p = r.payload as unknown as {
      platformKey: string;
      roleCategory: string;
      userCount: number;
      concentrationScore: number;
      formula: string;
      totalUsersInAgency: number;
    };
    cells.push({
      platformKey: p.platformKey,
      roleCategory: p.roleCategory,
      userCount: p.userCount,
      concentrationScore: p.concentrationScore,
      formula: p.formula,
    });
    if (p.totalUsersInAgency > totalUsersInAgency) totalUsersInAgency = p.totalUsersInAgency;
    if (r.captured_at > capturedAt) capturedAt = r.captured_at;
  }

  cells.sort(
    (a, b) =>
      a.platformKey.localeCompare(b.platformKey) ||
      a.roleCategory.localeCompare(b.roleCategory),
  );

  return {
    agencyId: latestRows[0].agency_id,
    capturedAt,
    totalUsersInAgency,
    cells,
  };
}

/** Return the most-recent trend rows for the given agency. */
export async function readTrendSeries(agencyId: string, days = 90): Promise<TrendSnapshot | null> {
  const { prisma } = getRuntime();
  const rows = await prisma.access_analytics_snapshots.findMany({
    where: { agency_id: agencyId, kind: 'trend' },
    orderBy: { captured_at_day: 'desc' },
    take: days,
  });
  if (rows.length === 0) return null;

  const series = rows
    .map((r: { payload: unknown }) => r.payload as unknown as TrendPoint)
    .sort((a: TrendPoint, b: TrendPoint) => a.day.localeCompare(b.day));

  return {
    agencyId: rows[0].agency_id,
    capturedAt: rows[0].captured_at,
    series,
  };
}
