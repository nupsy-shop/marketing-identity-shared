/**
 * Cost Optimization — shared types (Issue #58).
 *
 * Pure types only. Helpers live alongside in detectors.ts / scanner.ts.
 * See docs/features/cost-optimization-dashboard/README.md for the promise.
 *
 * Framework-agnostic: no Next.js or `@/` imports. Consumed by both the
 * marketing-identity web app's nightly scheduler script and the
 * per-agency Bull worker.
 */

export type RoleCategory = 'admin' | 'editor' | 'read_only' | 'uncategorized';

export interface RoleCategoryEntry {
  category: RoleCategory;
  readonly?: boolean;
}

export type FindingCategory = 'unused' | 'duplicate' | 'over_provisioned';
export type FindingStatus = 'open' | 'snoozed' | 'resolved' | 'acknowledged';
export type Recommendation = 'revoke' | 'downgrade' | 'snooze' | 'keep';

export interface Grant {
  grantId: string;
  userId: string;
  platformKey: string;
  role: string;
  createdAt: Date;
  revokedAt?: Date | null;
  agencyId: string;
}

export interface ActivitySnapshot {
  userId: string;
  lastActivityAt: Date | null;
  /** 'audit' (ES) | 'session' (session_events) | 'unknown' (platform doesn't ingest signals) */
  source: 'audit' | 'session' | 'unknown';
  /** Last 60d: did this user perform any write-class operation? */
  hasWriteActivity?: boolean;
}

export interface DetectorConfig {
  /** Days for both grant-age and activity windows. Default 60. */
  windowDays: number;
  /** Current time — injected so tests can freeze it. */
  now: Date;
  /** Lago seat cost in cents/month, or null when unavailable. */
  seatCostCents: number | null;
}

export interface DetectedFinding {
  category: FindingCategory;
  userId: string;
  /** Platform key; for duplicates we use 'cluster' + sort first grant's key. */
  platformKey: string;
  /** Role string; stable per-key part of the dedup tuple. */
  role: string;
  estimatedMonthlyCostCents: number | null;
  recommendation: Recommendation;
  context: Record<string, unknown>;
}

export type ManifestMap = Record<string, Record<string, RoleCategoryEntry> | undefined>;

export function categoryFor(
  manifestMap: ManifestMap,
  platformKey: string,
  role: string,
): RoleCategory {
  const map = manifestMap[platformKey];
  if (!map) return 'uncategorized';
  const entry = map[role];
  if (!entry) return 'uncategorized';
  return entry.category;
}

export function isReadonlyRole(
  manifestMap: ManifestMap,
  platformKey: string,
  role: string,
): boolean {
  const entry = manifestMap[platformKey]?.[role];
  return !!entry?.readonly;
}
