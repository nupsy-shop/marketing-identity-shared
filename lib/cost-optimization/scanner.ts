/**
 * Cost Optimization — per-agency scanner glue (Issue #58).
 *
 * The scanner COMPOSES the three pure detectors. It never calls revoke
 * endpoints; it only writes findings. Status/snooze_until are preserved
 * across runs — a re-run of the scanner must NEVER silently reset an
 * operator's action.
 *
 * Framework-agnostic: prisma is pulled via getRuntime() so the web app
 * and the Bull worker share one implementation.
 */

import { findUnused, findDuplicates, findOverProvisioned } from './detectors.js';
import type {
  ActivitySnapshot,
  DetectedFinding,
  DetectorConfig,
  Grant,
  ManifestMap,
} from './types.js';
import { getRuntime } from '../runtime.js';

export interface ScanResult {
  agencyId: string;
  categoryCounts: Record<string, number>;
  estimatedMonthlySavingsCents: number | null;
  writtenCount: number;
  resolvedStaleCount: number;
}

/**
 * Merge newly-detected findings with persisted rows.
 *
 *   - New finding, no prior row  → insert (status=open).
 *   - New finding, prior row exists  → upsert; DO NOT reset status.
 *     (If the operator had snoozed/resolved it and the rule still fires,
 *     the status stays as-is. The scanner never silently re-opens.)
 *   - Prior row, no longer fires  → mark resolved (auto-resolved) IFF
 *     status was 'open'. Snoozed/acknowledged rows keep their status
 *     unless their snoozed_until lapsed — caller handles that.
 */
export async function writeFindingsForAgency(
  agencyId: string,
  detected: DetectedFinding[],
): Promise<{ written: number; resolvedStale: number }> {
  const { prisma } = getRuntime();
  const existing = await prisma.cost_optimization_findings.findMany({
    where: { agency_id: agencyId, status: { not: 'resolved' } },
  });

  const key = (f: { category: string; user_id: string; platform_key: string; role: string }) =>
    `${f.category}::${f.user_id}::${f.platform_key}::${f.role}`;

  const existingByKey = new Map(
    (existing as Array<{
      id: string;
      category: string;
      user_id: string;
      platform_key: string;
      role: string;
      status: string;
    }>).map((r) => [key(r), r]),
  );
  const detectedKeys = new Set<string>();

  let written = 0;
  for (const f of detected) {
    const k = `${f.category}::${f.userId}::${f.platformKey}::${f.role}`;
    detectedKeys.add(k);

    const prior = existingByKey.get(k);
    if (prior) {
      // Update cost + context, DO NOT reset status.
      await prisma.cost_optimization_findings.update({
        where: { id: prior.id },
        data: {
          estimated_monthly_cost_cents: f.estimatedMonthlyCostCents,
          recommendation: f.recommendation,
          context: f.context,
          updated_at: new Date(),
        },
      });
    } else {
      await prisma.cost_optimization_findings.create({
        data: {
          agency_id: agencyId,
          category: f.category,
          user_id: f.userId,
          platform_key: f.platformKey,
          role: f.role,
          estimated_monthly_cost_cents: f.estimatedMonthlyCostCents,
          recommendation: f.recommendation,
          status: 'open',
          context: f.context,
        },
      });
    }
    written += 1;
  }

  // Auto-resolve stale 'open' rows whose rule no longer fires.
  let resolvedStale = 0;
  for (const prior of existingByKey.values()) {
    const k = key(prior);
    if (detectedKeys.has(k)) continue;
    if (prior.status !== 'open') continue; // never silently resolve snoozed/acknowledged
    await prisma.cost_optimization_findings.update({
      where: { id: prior.id },
      data: { status: 'resolved', resolved_at: new Date(), updated_at: new Date() },
    });
    resolvedStale += 1;
  }

  return { written, resolvedStale };
}

/**
 * Run the three detectors over per-agency data and produce the full
 * findings list. Pure apart from its inputs — all I/O lives in the
 * calling script.
 */
export function computeFindings(
  grants: Grant[],
  activity: Map<string, ActivitySnapshot>,
  manifestMap: ManifestMap,
  config: DetectorConfig,
): DetectedFinding[] {
  const unused = findUnused(grants, activity, config);
  const duplicates = findDuplicates(grants, manifestMap, config);
  const overProv = findOverProvisioned(grants, activity, manifestMap, config);
  return [...unused, ...duplicates, ...overProv];
}

export function summarize(
  detected: DetectedFinding[],
  seatCostCents: number | null,
): { categoryCounts: Record<string, number>; estimatedMonthlySavingsCents: number | null } {
  const categoryCounts: Record<string, number> = { unused: 0, duplicate: 0, over_provisioned: 0 };
  let total = 0;
  let anyWithCost = false;
  for (const f of detected) {
    categoryCounts[f.category] = (categoryCounts[f.category] || 0) + 1;
    if (f.estimatedMonthlyCostCents !== null) {
      total += f.estimatedMonthlyCostCents;
      anyWithCost = true;
    }
  }
  return {
    categoryCounts,
    estimatedMonthlySavingsCents:
      seatCostCents === null || !anyWithCost ? null : total,
  };
}
