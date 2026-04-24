/**
 * Drift finder (issue #90).
 *
 * Reads open drift signals from `drift_findings` — rows where
 * `state='unhealthy'` and `resolved_at IS NULL`. Each row becomes one
 * `Finding` shaped for the orchestrator (`evaluateAndRemediate`). The
 * orchestrator applies the autonomy matrix, policy exclusions, rate
 * limit + circuit breaker, then routes Local Directory signals into
 * the workflow engine.
 *
 * Agency-level `remediation_policies.drift.excludePlatforms` /
 * `excludeUsers` are honoured here — findings matching an exclusion are
 * filtered out before the orchestrator even sees them.
 */

import { getRuntime } from '../../runtime.js';
import type { Finder, ProducerFinding } from '../remediation-types.js';

interface DriftFindingRow {
  id: string;
  source_plugin_key: string;
  principal_type: string;
  principal_id: string;
  drift_type: string;
}

export const driftFinder: Finder = async (agencyId, policy) => {
  const rows = (await getRuntime().prisma.drift_findings.findMany({
    where: {
      agency_id: agencyId,
      state: 'unhealthy',
      resolved_at: null,
    },
    select: {
      id: true,
      source_plugin_key: true,
      principal_type: true,
      principal_id: true,
      drift_type: true,
    },
    take: 200,
  })) as DriftFindingRow[];

  const excludePlatforms = new Set(policy?.excludePlatforms ?? []);
  const excludeUsers = new Set(policy?.excludeUsers ?? []);

  return rows
    .filter((r) => !excludePlatforms.has(r.source_plugin_key))
    .filter((r) => !excludeUsers.has(r.principal_id))
    .map((r): ProducerFinding => ({
      context: {
        driftFindingId: r.id,
        sourcePluginKey: r.source_plugin_key,
        principalType: r.principal_type,
        principalId: r.principal_id,
        driftType: r.drift_type,
      },
    }));
};
