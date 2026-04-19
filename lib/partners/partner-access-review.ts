/**
 * Partner Hub — monthly access review worker body (#63).
 *
 * Builds the per-agency digest and dispatches a
 * `partner.access_review.digest_sent` notification. Idempotent: the
 * digest is a snapshot, not a mutation; running twice in the same
 * calendar month produces two notifications with fresh timestamps but
 * no schema state change.
 *
 * Entitlement (`features.partnerDelegation` or
 * `accessPatterns.partnerDelegation`) is the caller's concern — the
 * dispatcher script does that before enqueueing. This worker body
 * assumes entitled and just runs.
 */

import { getRuntime } from '../runtime.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { buildAgencyDigest, type AgencyPartnerDigest } from './access-review.js';

export interface PartnerAccessReviewOptions {
  agencyId: string;
  dryRun?: boolean;
}

export interface PartnerAccessReviewResult {
  digest: AgencyPartnerDigest;
  dispatched: boolean;
}

export async function runPartnerAccessReviewForAgency(
  opts: PartnerAccessReviewOptions,
): Promise<PartnerAccessReviewResult> {
  const { logger } = getRuntime();

  const digest = await buildAgencyDigest(opts.agencyId);

  if (opts.dryRun) {
    logger.info('partner-access-review: dry-run digest built, skipping dispatch', {
      agencyId: opts.agencyId,
      activePartners: digest.activePartners,
      totalLinks: digest.totalLinks,
    });
    return { digest, dispatched: false };
  }

  try {
    await dispatchNotification(
      opts.agencyId,
      'partner.access_review.digest_sent',
      {
        agencyId: opts.agencyId,
        activePartners: digest.activePartners,
        linkedClients: digest.totalLinks,
      },
    );
  } catch (err) {
    logger.warn('partner-access-review: dispatchNotification failed', {
      agencyId: opts.agencyId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await publishAuditEvent({
      eventType: 'partner.access_review.digest_sent',
      source: 'partner-access-review',
      severity: 'info',
      agency: { id: opts.agencyId },
      actor: { id: 'system', type: 'system' },
      context: {
        activePartners: digest.activePartners,
        linkedClients: digest.totalLinks,
        generatedAt: digest.generatedAt,
      },
    });
  } catch (err) {
    logger.warn('partner-access-review: audit publish failed', {
      agencyId: opts.agencyId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('partner-access-review: digest dispatched', {
    agencyId: opts.agencyId,
    activePartners: digest.activePartners,
    totalLinks: digest.totalLinks,
  });

  return { digest, dispatched: true };
}

/**
 * True on the 1st day of the month (UTC). The dispatcher script runs
 * daily but the Heroku Scheduler cadence ultimately determines frequency;
 * this helper lets callers enforce the monthly cadence regardless.
 */
export function isFirstOfMonth(now: Date = new Date()): boolean {
  return now.getUTCDate() === 1;
}
