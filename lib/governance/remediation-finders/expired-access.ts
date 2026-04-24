/**
 * Finder: expired access (items whose `expiresAt` has passed but are still
 * marked completed).
 *
 * Extracted verbatim from `remediation-engine.ts` (`PRODUCERS.expiredAccess`)
 * as part of issue #91.
 */

import { getRuntime } from '../../runtime.js';
import type { Finder, ProducerFinding } from '../remediation-types.js';

interface AccessItemRow {
  id: string;
  platformId: string | null;
}

export const expiredAccessFinder: Finder = async (agencyId) => {
  const rows = (await getRuntime().prisma.access_request_items.findMany({
    where: {
      agency_id: agencyId,
      status: 'completed',
      expiresAt: { not: null, lt: new Date() },
    },
    select: { id: true, platformId: true },
    take: 50,
  })) as AccessItemRow[];
  return rows.map((r): ProducerFinding => ({
    context: { accessRequestItemIds: [r.id], platformKey: r.platformId || '' },
  }));
};
