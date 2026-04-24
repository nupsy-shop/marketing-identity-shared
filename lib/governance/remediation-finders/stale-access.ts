/**
 * Finder: stale access (access still marked completed long past its
 * `updatedAt` threshold).
 *
 * Extracted verbatim from `remediation-engine.ts` (`PRODUCERS.staleAccess`)
 * as part of issue #91. No behaviour change — same Prisma query, same shape.
 */

import { getRuntime } from '../../runtime.js';
import type {
  Finder,
  ProducerFinding,
  RemediationPolicy,
} from '../remediation-types.js';

const DEFAULT_STALE_DAYS = 90;

export const staleAccessFinder: Finder = async (agencyId, policy) => {
  const staleDays =
    Number((policy as RemediationPolicy & { staleDays?: number }).staleDays) ||
    DEFAULT_STALE_DAYS;
  const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
  const rows = await getRuntime().prisma.access_request_items.findMany({
    where: { agency_id: agencyId, status: 'completed', updatedAt: { lt: cutoff } },
    select: { id: true, platformId: true },
    take: 50,
  });
  return rows.map<ProducerFinding>((r) => ({
    context: {
      accessRequestItemIds: [r.id],
      platformKey: r.platformId || '',
      staleDays,
    },
  }));
};
