/**
 * Finder: failed verification (items whose verification either failed or has
 * been pending for longer than `suspendAfterDays`).
 *
 * Extracted verbatim from `remediation-engine.ts`
 * (`PRODUCERS.failedVerification`) as part of issue #91.
 */

import { getRuntime } from '../../runtime.js';
import type {
  Finder,
  ProducerFinding,
  RemediationPolicy,
} from '../remediation-types.js';

const DEFAULT_SUSPEND_AFTER_DAYS = 7;

export const failedVerificationFinder: Finder = async (agencyId, policy) => {
  const suspendAfterDays =
    Number(
      (policy as RemediationPolicy & { suspendAfterDays?: number })
        .suspendAfterDays,
    ) || DEFAULT_SUSPEND_AFTER_DAYS;
  const cutoff = new Date(Date.now() - suspendAfterDays * 24 * 60 * 60 * 1000);
  const rows = await getRuntime().prisma.access_request_items.findMany({
    where: {
      agency_id: agencyId,
      status: 'completed',
      OR: [
        { verification_status: 'failed' },
        { verification_status: 'pending', createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true, platformId: true, verification_status: true },
    take: 50,
  });
  return rows.map<ProducerFinding>((r) => ({
    context: {
      accessRequestItemIds: [r.id],
      platformKey: r.platformId || '',
      verificationStatus: r.verification_status,
      suspendAfterDays,
    },
  }));
};
