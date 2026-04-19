/**
 * Activation-at-first-open pass (shared).
 *
 * Transitions scheduled grants from `window_suspended` to `validated` the
 * first time they fall inside their window, sets `first_activated_at`, and
 * fires `access.window.activated` exactly once per grant.
 *
 * Agency-scoped: the caller MUST pass `agencyId`; every query filters on it.
 * Runtime services (prisma, logger) come from `getRuntime()` — this module
 * is framework-agnostic and works identically in the web app and the Bull
 * worker.
 */

import { getRuntime } from '../runtime.js';
import { isInWindow, summarizeSchedule, type AccessSchedule } from './resolver.js';

export interface ActivationStats {
  scanned: number;
  activated: number;
  errors: number;
}

export interface ActivationOptions {
  agencyId: string;
  now?: Date;
  dryRun?: boolean;
  publishAudit?: (payload: {
    agencyId: string;
    grantId: string;
    userId: string | null;
    platformKey: string | null;
    windowStart: string;
    scheduleSummary: string;
  }) => Promise<void>;
}

/**
 * Run the activation pass for all scheduled grants in a single agency.
 * Every query filters on `agencyId` — no cross-tenant read ever occurs.
 */
export async function runActivationPass(opts: ActivationOptions): Promise<ActivationStats> {
  const { prisma, logger } = getRuntime();
  const stats: ActivationStats = { scanned: 0, activated: 0, errors: 0 };
  const now = opts.now ?? new Date();

  const candidates = await prisma.access_request_items.findMany({
    where: {
      agency_id: opts.agencyId,
      status: 'window_suspended',
      first_activated_at: null,
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
      platformId: true,
      accessRequestId: true,
    },
  });

  stats.scanned = candidates.length;

  for (const item of candidates) {
    try {
      let schedule: AccessSchedule | null = null;
      if (item.accessSchedule && typeof item.accessSchedule === 'object') {
        schedule = item.accessSchedule as AccessSchedule;
      }

      const tz = schedule?.timezone ?? null;
      const st = schedule?.startTime ?? null;
      const et = schedule?.endTime ?? null;

      const inWindow = isInWindow(
        { rrule: item.rrule, accessSchedule: schedule, timezone: tz, startTime: st, endTime: et },
        now,
      );
      if (!inWindow) continue;

      if (opts.dryRun) {
        logger.info('access-windows.activation: dry-run would activate', { grantId: item.id });
        stats.activated++;
        continue;
      }

      await prisma.access_request_items.update({
        where: { id: item.id },
        data: {
          first_activated_at: now,
          status: 'validated',
          updatedAt: now,
        },
      });

      const summary = summarizeSchedule({
        rrule: item.rrule,
        accessSchedule: schedule,
        timezone: tz,
        startTime: st,
        endTime: et,
      });

      if (opts.publishAudit) {
        try {
          await opts.publishAudit({
            agencyId: item.agency_id,
            grantId: item.id,
            userId: null,
            platformKey: null,
            windowStart: now.toISOString(),
            scheduleSummary: summary,
          });
        } catch (e) {
          logger.error('access-windows.activation: audit publish failed', {
            grantId: item.id,
            err: e instanceof Error ? e.message : String(e),
          });
        }
      }

      logger.info('access-windows.activation: activated first window', { grantId: item.id });
      stats.activated++;
    } catch (err) {
      logger.error('access-windows.activation: error on candidate', {
        grantId: item.id,
        err: err instanceof Error ? err.message : String(err),
      });
      stats.errors++;
    }
  }

  return stats;
}
