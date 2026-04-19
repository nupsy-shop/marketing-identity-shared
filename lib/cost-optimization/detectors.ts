/**
 * Cost Optimization — pure detectors (Issue #58).
 *
 * Three pure functions — no I/O, no DB, no ES. Fixtures drive unit tests
 * with frozen-time snapshots. Scanner glue in scanner.ts composes these
 * over per-agency data.
 *
 * Rules (docs/features/cost-optimization-dashboard/scenarios.feature):
 *   - unused: grant age ≥ window AND no activity in window (AND, not OR).
 *   - duplicate: cluster by (user, effective role category) across platforms.
 *     Single-grant category → NEVER flagged. Uncategorized → NEVER flagged.
 *   - over_provisioned: admin role AND only read-level activity in window.
 *     Roles manifest-flagged readonly=true → NEVER flagged.
 */

import {
  type ActivitySnapshot,
  type DetectorConfig,
  type DetectedFinding,
  type Grant,
  type ManifestMap,
  categoryFor,
  isReadonlyRole,
} from './types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function daysBetween(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

function computeCost(
  seatCostCents: number | null,
  seatCount: number,
): number | null {
  if (seatCostCents === null) return null;
  return seatCostCents * seatCount;
}

// ─── Unused licenses ────────────────────────────────────────────────────────

export function findUnused(
  grants: Grant[],
  activity: Map<string, ActivitySnapshot>,
  config: DetectorConfig,
): DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  for (const grant of grants) {
    if (grant.revokedAt) continue;

    const grantAgeDays = daysBetween(grant.createdAt, config.now);
    // Fresh grant — never flagged as unused.
    if (grantAgeDays < config.windowDays) continue;

    const act = activity.get(grant.userId);
    // Platform without activity signals — never flagged (false-positive avoidance).
    if (!act || act.source === 'unknown') continue;

    const lastActiveDays = act.lastActivityAt
      ? daysBetween(act.lastActivityAt, config.now)
      : Infinity;
    if (lastActiveDays < config.windowDays) continue;

    findings.push({
      category: 'unused',
      userId: grant.userId,
      platformKey: grant.platformKey,
      role: grant.role,
      estimatedMonthlyCostCents: computeCost(config.seatCostCents, 1),
      recommendation: 'revoke',
      context: {
        grantIds: [grant.grantId],
        grantAgeDays: Math.floor(grantAgeDays),
        lastActivityAt: act.lastActivityAt?.toISOString() ?? null,
        activitySource: act.source,
      },
    });
  }
  return findings;
}

// ─── Duplicate grants ───────────────────────────────────────────────────────

export function findDuplicates(
  grants: Grant[],
  manifestMap: ManifestMap,
  config: DetectorConfig,
): DetectedFinding[] {
  // Cluster active grants by (userId, categoryFromManifest).
  const clusters = new Map<string, Grant[]>();
  for (const grant of grants) {
    if (grant.revokedAt) continue;
    const cat = categoryFor(manifestMap, grant.platformKey, grant.role);
    // Uncategorized → safe default, never a duplicate.
    if (cat === 'uncategorized') continue;
    const key = `${grant.userId}::${cat}`;
    const bucket = clusters.get(key) || [];
    bucket.push(grant);
    clusters.set(key, bucket);
  }

  const findings: DetectedFinding[] = [];
  for (const [key, bucket] of clusters) {
    if (bucket.length < 2) continue; // single-grant category is NOT a duplicate
    const [userId, cat] = key.split('::');
    // Stable role/platform key — sort grant ids so the dedup tuple is deterministic.
    const sorted = [...bucket].sort((a, b) => a.grantId.localeCompare(b.grantId));
    const first = sorted[0];
    findings.push({
      category: 'duplicate',
      userId,
      platformKey: 'cluster',
      role: cat, // the normalized category is the "role" for dedup purposes
      estimatedMonthlyCostCents: computeCost(
        config.seatCostCents,
        // Savings = removing all but one seat in the cluster.
        sorted.length - 1,
      ),
      recommendation: 'revoke',
      context: {
        grantIds: sorted.map((g) => g.grantId),
        platformKeys: sorted.map((g) => g.platformKey),
        roleCategory: cat,
        firstGrantId: first.grantId,
      },
    });
  }
  return findings;
}

// ─── Over-provisioned admins ────────────────────────────────────────────────

export function findOverProvisioned(
  grants: Grant[],
  activity: Map<string, ActivitySnapshot>,
  manifestMap: ManifestMap,
  config: DetectorConfig,
): DetectedFinding[] {
  const findings: DetectedFinding[] = [];
  for (const grant of grants) {
    if (grant.revokedAt) continue;
    // Readonly roles are NEVER flagged over-provisioned — that is nonsense noise.
    if (isReadonlyRole(manifestMap, grant.platformKey, grant.role)) continue;

    const cat = categoryFor(manifestMap, grant.platformKey, grant.role);
    if (cat !== 'admin') continue;

    const act = activity.get(grant.userId);
    if (!act || act.source === 'unknown') continue;
    // Over-provisioned only fires when we have evidence of ONLY read activity.
    if (act.hasWriteActivity) continue;
    if (!act.lastActivityAt) continue; // no activity at all → unused path, not this one

    findings.push({
      category: 'over_provisioned',
      userId: grant.userId,
      platformKey: grant.platformKey,
      role: grant.role,
      estimatedMonthlyCostCents: computeCost(config.seatCostCents, 1),
      recommendation: 'downgrade',
      context: {
        grantIds: [grant.grantId],
        lastActivityAt: act.lastActivityAt.toISOString(),
        activitySource: act.source,
        observedRoleCategory: cat,
      },
    });
  }
  return findings;
}
