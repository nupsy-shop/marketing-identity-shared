/**
 * Per-agency contractor contract-expiration notifier (shared) — issue #55.
 *
 * For a single agency entitled to `contractorManagement`:
 *   1. Pre-expiry (T-30/14/7/1) notices via `dispatchNotification` with
 *      dedup via `contract_notification_log (user_id, threshold_days)`.
 *   2. Auto-offboard branch for `contract_end_at <= now AND auto_offboard=true`
 *      fires `directory.user.contract_expired` and enqueues
 *      `jml_process_lifecycle` with a contractor-expiry payload. The
 *      web-side lifecycle processor already owns revocation orchestration
 *      via the same policy path HR-triggered leavers use.
 *
 * Invariants:
 *   - Prisma only (no raw SQL).
 *   - Every query filters on `agencyId`.
 *   - Notification + audit payloads carry IDs + dates + threshold/flags only
 *     — no PII beyond userId, no contract-agreement bodies, no credentials.
 *   - Dedup is DB-level: insert the log row first; on P2002 we treat the
 *     threshold as already fired and skip the dispatch.
 *
 * Entitlement gating is optional (caller-supplied). When not entitled, emits
 * ONE `directory.user.contract_expiring.skipped` audit per scan with reason
 * `not_entitled`.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { contractNotificationThresholds } from './thresholds.js';

export const CONTRACT_EXPIRING = 'directory.user.contract_expiring';
export const CONTRACT_EXPIRED  = 'directory.user.contract_expired';

export interface NotifyContractExpirationsOptions {
  agencyId: string;
  now?: Date;
  /** Optional entitlement gate; caller-supplied. */
  isEntitled?: (agencyId: string) => Promise<boolean>;
}

export interface NotifyContractExpirationsStats {
  contractorsScanned: number;
  notificationsFired: number;
  duplicatesSkipped: number;
  autoOffboardEnqueued: number;
  manualReview: number;
  errors: number;
}

export type NotifyContractExpirationsResult =
  | { status: 'skipped'; reason: 'not_entitled'; stats: NotifyContractExpirationsStats }
  | { status: 'completed'; stats: NotifyContractExpirationsStats };

function emptyStats(): NotifyContractExpirationsStats {
  return {
    contractorsScanned: 0,
    notificationsFired: 0,
    duplicatesSkipped: 0,
    autoOffboardEnqueued: 0,
    manualReview: 0,
    errors: 0,
  };
}

async function emitSkippedNotEntitled(agencyId: string): Promise<void> {
  await publishAuditEvent({
    eventType: 'directory.user.contract_expiring.skipped',
    source: 'notify-contract-expirations',
    severity: 'info',
    agency: { id: agencyId },
    actor: { id: 'system', type: 'system' },
    context: { reason: 'not_entitled' },
  }).catch(() => { /* non-fatal */ });
}

/**
 * Scan a single agency for contractor contract expirations. Handles both
 * pre-expiry notices (T-30/14/7/1) and the auto-offboard leaver branch.
 */
export async function notifyContractExpirationsForAgency(
  opts: NotifyContractExpirationsOptions,
): Promise<NotifyContractExpirationsResult> {
  const { prisma, logger, enqueueJob } = getRuntime();
  const now = opts.now ?? new Date();
  const stats = emptyStats();

  if (opts.isEntitled) {
    let entitled = false;
    try {
      entitled = await opts.isEntitled(opts.agencyId);
    } catch (err) {
      logger.warn('notify-contract-expirations: entitlement resolve failed', {
        agencyId: opts.agencyId,
        err: err instanceof Error ? err.message : String(err),
      });
      entitled = false;
    }
    if (!entitled) {
      await emitSkippedNotEntitled(opts.agencyId);
      return { status: 'skipped', reason: 'not_entitled', stats };
    }
  }

  // ─── 1. Auto-offboard branch — contracts already past end ─────────────
  // Contractors whose contract ended AND auto_offboard=true AND still active.
  // Fire the leaver path via jml_process_lifecycle (web-side handler owns
  // the actual revocation engine). Also emits `contract_expired` audit.
  const expired = await prisma.users.findMany({
    where: {
      agency_id: opts.agencyId,
      user_type: 'contractor',
      is_active: true,
      contract_end_at: { not: null, lte: now },
    },
    select: {
      id: true,
      email: true,
      auto_offboard: true,
      contract_start_at: true,
      contract_end_at: true,
      renewal_count: true,
    },
  });

  for (const u of expired) {
    if (!u.contract_end_at) continue;
    try {
      const payload = {
        userId: u.id,
        contractStartAt: u.contract_start_at?.toISOString() ?? null,
        contractEndAt: u.contract_end_at.toISOString(),
        renewalCount: u.renewal_count,
        autoOffboard: u.auto_offboard,
      };

      await publishAuditEvent({
        eventType: CONTRACT_EXPIRED,
        source: 'notify-contract-expirations',
        severity: 'warning',
        agency: { id: opts.agencyId },
        actor: { id: 'system', type: 'system' },
        resource: { type: 'user', id: u.id },
        context: payload,
      }).catch(() => { /* non-fatal */ });

      if (u.auto_offboard) {
        if (enqueueJob) {
          await enqueueJob('jml_process_lifecycle', {
            tenantId: opts.agencyId,
            principal: u.email,
            userId: u.id,
            events: { leavers: [u.email] },
            triggeredBy: 'contract-expired',
            pluginKey: 'contractor-expiry',
            sourceId: null,
          });
          stats.autoOffboardEnqueued++;
        } else {
          logger.warn('notify-contract-expirations: enqueueJob unavailable, cannot auto-offboard', {
            agencyId: opts.agencyId,
            userId: u.id,
          });
          stats.manualReview++;
        }
      } else {
        stats.manualReview++;
      }
    } catch (err) {
      stats.errors++;
      logger.error('notify-contract-expirations: auto-offboard branch failed', {
        agencyId: opts.agencyId,
        userId: u.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 2. Pre-expiry notices — contracts within next 30 days ─────────────
  const horizonMs = 30 * 24 * 60 * 60 * 1000;
  const horizon = new Date(now.getTime() + horizonMs);

  const upcoming = await prisma.users.findMany({
    where: {
      agency_id: opts.agencyId,
      user_type: 'contractor',
      is_active: true,
      contract_end_at: { not: null, lte: horizon, gt: now },
    },
    select: {
      id: true,
      email: true,
      name: true,
      contract_start_at: true,
      contract_end_at: true,
      renewal_count: true,
    },
  });

  for (const u of upcoming) {
    stats.contractorsScanned++;
    if (!u.contract_end_at) continue;

    const due = contractNotificationThresholds(u.contract_end_at, now);
    if (due.length === 0) continue;

    for (const threshold of due) {
      try {
        // Dedup: insert log first; unique (user_id, threshold_days).
        try {
          await prisma.contract_notification_log.create({
            data: {
              user_id: u.id,
              agency_id: opts.agencyId,
              threshold_days: threshold,
              contract_end_at: u.contract_end_at,
              event_type: CONTRACT_EXPIRING,
            },
          });
        } catch (err: unknown) {
          const code = (err as { code?: string })?.code;
          if (code === 'P2002') {
            stats.duplicatesSkipped++;
            continue;
          }
          throw err;
        }

        const payload = {
          userId: u.id,
          thresholdDays: threshold,
          contractStartAt: u.contract_start_at?.toISOString() ?? null,
          contractEndAt: u.contract_end_at.toISOString(),
          renewalCount: u.renewal_count,
        };

        await dispatchNotification(opts.agencyId, CONTRACT_EXPIRING, payload);
        await publishAuditEvent({
          eventType: CONTRACT_EXPIRING,
          source: 'notify-contract-expirations',
          severity: 'warning',
          agency: { id: opts.agencyId },
          actor: { id: 'system', type: 'system' },
          resource: { type: 'user', id: u.id },
          context: payload,
        }).catch(() => { /* non-fatal */ });
        stats.notificationsFired++;
      } catch (err) {
        stats.errors++;
        logger.error('notify-contract-expirations: threshold fire failed', {
          agencyId: opts.agencyId,
          userId: u.id,
          threshold,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logger.info('notify-contract-expirations: scan complete', {
    agencyId: opts.agencyId,
    ...stats,
  });

  return { status: 'completed', stats };
}
