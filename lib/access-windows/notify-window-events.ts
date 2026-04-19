/**
 * Access-window opened/closed notifier (shared, per-agency).
 *
 * Scans an agency's scheduled grants and fires
 * `access.window.opened` / `access.window.closed` audit events +
 * notifications at each boundary crossing. Dedup via
 * `window_notification_log` (grant_id, window_start, event_type) —
 * one row per boundary, so clock drift across scheduler ticks never
 * produces a duplicate event.
 *
 * Invariants:
 *   - NEVER re-provisions grants. Events only.
 *   - NEVER queries across agencies — every `where` filters on agencyId.
 *   - NEVER fires `access.window.activated` (that is the activation pass).
 *
 * Entitlement resolution is injected via `isEntitled`; the caller decides
 * how to resolve `features.timeBoundAccess` (web → live entitlements,
 * worker → same call under `withTenantContext`).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { resolveWindows, summarizeSchedule, type AccessSchedule } from './resolver.js';

// How far back/forward from `now` we consider a boundary "just crossed".
// Scheduler runs every 5 min, so a 6-min grace covers the previous tick.
export const DEFAULT_BOUNDARY_WINDOW_MS = 6 * 60 * 1000;

export interface NotifyWindowEventsOptions {
  agencyId: string;
  now?: Date;
  dryRun?: boolean;
  boundaryWindowMs?: number;
  /**
   * Optional entitlement gate. When provided and it returns false, the
   * scan short-circuits with `skipped_not_entitled`.
   */
  isEntitled?: (agencyId: string) => Promise<boolean>;
}

export interface NotifyWindowEventsStats {
  grantsScanned: number;
  opensFired: number;
  closesFired: number;
  skippedDedup: number;
  errors: number;
}

export type NotifyWindowEventsResult =
  | { status: 'skipped'; reason: 'not_entitled'; stats: NotifyWindowEventsStats }
  | { status: 'completed'; stats: NotifyWindowEventsStats };

interface GrantRow {
  id: string;
  agency_id: string;
  rrule: string | null;
  accessSchedule: unknown;
  status: string;
  first_activated_at: Date | null;
  resolvedIdentity: string | null;
  platformId: string;
  catalog_platforms: { slug: string | null; name: string | null } | null;
}

export async function notifyWindowEventsForAgency(
  opts: NotifyWindowEventsOptions,
): Promise<NotifyWindowEventsResult> {
  const { prisma, logger } = getRuntime();
  const now = opts.now ?? new Date();
  const boundaryMs = opts.boundaryWindowMs ?? DEFAULT_BOUNDARY_WINDOW_MS;
  const stats: NotifyWindowEventsStats = {
    grantsScanned: 0,
    opensFired: 0,
    closesFired: 0,
    skippedDedup: 0,
    errors: 0,
  };

  if (opts.isEntitled) {
    let entitled = false;
    try {
      entitled = await opts.isEntitled(opts.agencyId);
    } catch (err) {
      logger.warn('access-windows.notify: entitlement resolve failed', {
        agencyId: opts.agencyId,
        err: err instanceof Error ? err.message : String(err),
      });
      entitled = false;
    }
    if (!entitled) {
      return { status: 'skipped', reason: 'not_entitled', stats };
    }
  }

  const grants = (await prisma.access_request_items.findMany({
    where: {
      agency_id: opts.agencyId,
      status: { in: ['validated', 'window_suspended'] },
      OR: [
        { rrule: { not: null } },
        { accessSchedule: { not: undefined } as never },
      ],
    },
    select: {
      id: true,
      agency_id: true,
      rrule: true,
      accessSchedule: true,
      status: true,
      first_activated_at: true,
      resolvedIdentity: true,
      platformId: true,
      catalog_platforms: { select: { slug: true, name: true } },
    },
  })) as unknown as GrantRow[];

  stats.grantsScanned = grants.length;

  for (const grant of grants) {
    try {
      const schedule =
        grant.accessSchedule && typeof grant.accessSchedule === 'object'
          ? (grant.accessSchedule as AccessSchedule)
          : null;

      const input = {
        rrule: grant.rrule,
        accessSchedule: schedule,
        timezone: schedule?.timezone ?? null,
        startTime: schedule?.startTime ?? null,
        endTime: schedule?.endTime ?? null,
      };

      const from = new Date(now.getTime() - boundaryMs);
      const windows = resolveWindows(input, from, 3);

      for (const w of windows) {
        const start = Date.parse(w.start);
        const end = Date.parse(w.end);
        const summary = summarizeSchedule(input);
        const platformKey = grant.catalog_platforms?.slug ?? null;

        // Just OPENED? (start within boundary window)
        if (Math.abs(now.getTime() - start) <= boundaryMs && start <= now.getTime()) {
          // Only fire `opened` if we've already activated — first window fires
          // `activated` from the expiry / activation pass, not here.
          if (grant.first_activated_at) {
            await maybeFire({
              grantId: grant.id,
              agencyId: opts.agencyId,
              windowStart: new Date(start),
              eventType: 'opened',
              platformKey,
              userId: grant.resolvedIdentity,
              windowStartIso: w.start,
              windowEndIso: w.end,
              scheduleSummary: summary,
              now,
              dryRun: !!opts.dryRun,
              stats,
            });
          }
        }

        // Just CLOSED? (end within boundary window)
        if (Math.abs(now.getTime() - end) <= boundaryMs && end <= now.getTime()) {
          await maybeFire({
            grantId: grant.id,
            agencyId: opts.agencyId,
            windowStart: new Date(start),
            eventType: 'closed',
            platformKey,
            userId: grant.resolvedIdentity,
            windowStartIso: w.start,
            windowEndIso: w.end,
            scheduleSummary: summary,
            now,
            dryRun: !!opts.dryRun,
            stats,
          });
        }
      }
    } catch (err) {
      logger.error('access-windows.notify: grant scan error', {
        grantId: grant.id,
        agencyId: opts.agencyId,
        err: err instanceof Error ? err.message : String(err),
      });
      stats.errors++;
    }
  }

  return { status: 'completed', stats };
}

interface FireArgs {
  grantId: string;
  agencyId: string;
  windowStart: Date;
  eventType: 'opened' | 'closed';
  platformKey: string | null;
  userId: string | null;
  windowStartIso: string;
  windowEndIso: string;
  scheduleSummary: string;
  now: Date;
  dryRun: boolean;
  stats: NotifyWindowEventsStats;
}

async function maybeFire(args: FireArgs): Promise<void> {
  const { prisma, logger } = getRuntime();
  const fullEventType = args.eventType === 'opened' ? 'access.window.opened' : 'access.window.closed';

  if (args.dryRun) {
    logger.info('access-windows.notify: DRY would fire', {
      fullEventType,
      grantId: args.grantId,
      windowStart: args.windowStartIso,
    });
    if (args.eventType === 'opened') args.stats.opensFired++;
    else args.stats.closesFired++;
    return;
  }

  try {
    await prisma.window_notification_log.create({
      data: {
        grant_id: args.grantId,
        window_start: args.windowStart,
        event_type: args.eventType,
        agency_id: args.agencyId,
        fired_at: args.now,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('Unique') || msg.includes('P2002') || msg.includes('duplicate')) {
      args.stats.skippedDedup++;
      return;
    }
    throw err;
  }

  await publishAuditEvent({
    eventType: fullEventType,
    source: 'notify-window-events',
    severity: 'info',
    agency: { id: args.agencyId },
    resource: { type: 'access_request_item', id: args.grantId },
    context: {
      grantId: args.grantId,
      userId: args.userId,
      platformKey: args.platformKey,
      windowStart: args.windowStartIso,
      windowEnd: args.windowEndIso,
      scheduleSummary: args.scheduleSummary,
    },
  });

  try {
    await dispatchNotification(args.agencyId, fullEventType, {
      grantId: args.grantId,
      platformKey: args.platformKey,
      windowStart: args.windowStartIso,
      windowEnd: args.windowEndIso,
      scheduleSummary: args.scheduleSummary,
    });
  } catch (err) {
    logger.error('access-windows.notify: dispatchNotification failed', {
      grantId: args.grantId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (args.eventType === 'opened') args.stats.opensFired++;
  else args.stats.closesFired++;
  logger.info('access-windows.notify: fired', {
    fullEventType,
    grantId: args.grantId,
    windowStart: args.windowStartIso,
  });
}
