/**
 * Cost Optimization — per-agency orchestrator (Issue #58).
 *
 * One function both the web app's nightly scheduler script and the
 * per-agency Bull worker call. Loads grants + activity, composes the
 * three detectors, writes findings, auto-resolves stale rows, and
 * stamps `agency_settings.last_cost_scan_at`.
 *
 * Host responsibilities (passed in):
 *   - `resolveSeatCostCents(agencyId)` — Lago lookup. Null → findings
 *     get `estimated_monthly_cost_cents: null`. The resolver lives in
 *     the host because Lago/Redis wiring varies (web has Redis cache,
 *     the worker short-circuits on cache misses).
 *   - `publishAudit(payload)` — optional. When omitted the orchestrator
 *     skips emission; the host already has its own audit publisher.
 *
 * Prisma is pulled via `getRuntime()`. Every query filters on
 * `agencyId` explicitly. The scanner NEVER calls revocation endpoints.
 */

import { buildRoleCategoryManifestMap } from './manifest-map.js';
import { computeFindings, summarize, writeFindingsForAgency } from './scanner.js';
import type { DetectedFinding, Grant } from './types.js';
import { getLastActivityForUsers } from '../activity/last-activity.js';
import { getRuntime } from '../runtime.js';

export interface PerAgencyScanInput {
  agencyId: string;
  /** Optional agency slug — stamped on the audit payload for searchability. */
  agencySlug?: string | null;
  /** Grant-age & activity window. Default 60. */
  windowDays?: number;
  /** Frozen-time hook for tests. Default `new Date()`. */
  now?: Date;
  /** Host-provided Lago resolver. Null → cost unavailable. */
  resolveSeatCostCents: (agencyId: string) => Promise<number | null>;
  /** Host-provided audit publisher. Skipped when omitted. */
  publishAudit?: (payload: {
    type: string;
    action: string;
    actor: { id: string; email: string };
    agency: { id: string; slug?: string };
    context: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Skip persistence — still compute + summarize. */
  dryRun?: boolean;
}

export interface PerAgencyScanResult {
  agencyId: string;
  grantCount: number;
  userCount: number;
  findings: DetectedFinding[];
  categoryCounts: Record<string, number>;
  estimatedMonthlySavingsCents: number | null;
  written: number;
  resolvedStale: number;
}

export async function scanCostOptimizationForAgency(
  input: PerAgencyScanInput,
): Promise<PerAgencyScanResult> {
  const {
    agencyId,
    agencySlug,
    windowDays = 60,
    now = new Date(),
    resolveSeatCostCents,
    publishAudit,
    dryRun,
  } = input;

  const { prisma, logger } = getRuntime();
  const manifestMap = buildRoleCategoryManifestMap();

  // Agency-scoped active grants.
  const grantRows = await prisma.session_grants.findMany({
    where: { agency_id: agencyId, revoked_at: null },
    select: {
      id: true,
      actor_user_id: true,
      access_item_id: true,
      agency_platform_id: true,
      created_at: true,
      revoked_at: true,
      policy_snapshot: true,
    },
  });

  // Resolve platform-key + role per grant. policy_snapshot stamps both
  // at grant-creation time; fall back to access_items → agency_platforms
  // → catalog_platforms.slug when the snapshot is stale.
  const accessItemIds = Array.from(
    new Set(
      (grantRows as Array<{ access_item_id: string }>).map((g) => g.access_item_id),
    ),
  );
  const accessItems = accessItemIds.length
    ? await prisma.access_items.findMany({
        where: { id: { in: accessItemIds }, agency_id: agencyId },
        select: {
          id: true,
          role: true,
          agency_platforms: { select: { catalog_platforms: { select: { slug: true } } } },
        },
      })
    : [];
  const itemMap = new Map(
    (accessItems as Array<{
      id: string;
      role: string | null;
      agency_platforms: { catalog_platforms: { slug: string } | null } | null;
    }>).map((i) => [i.id, i]),
  );

  const grants: Grant[] = (grantRows as Array<{
    id: string;
    actor_user_id: string;
    access_item_id: string;
    created_at: Date;
    revoked_at: Date | null;
    policy_snapshot: unknown;
  }>).map((g) => {
    const item = itemMap.get(g.access_item_id);
    const snapshot = (g.policy_snapshot || {}) as Record<string, unknown>;
    return {
      grantId: g.id,
      userId: g.actor_user_id,
      platformKey:
        (typeof snapshot.platformKey === 'string' && snapshot.platformKey) ||
        item?.agency_platforms?.catalog_platforms?.slug ||
        'unknown',
      role:
        (typeof snapshot.role === 'string' && snapshot.role) ||
        item?.role ||
        '',
      createdAt: g.created_at,
      revokedAt: g.revoked_at,
      agencyId,
    };
  });

  // Per-user activity snapshot (ES audit events, agency-scoped).
  const userIds = Array.from(new Set(grants.map((g) => g.userId)));
  const activity = await getLastActivityForUsers({
    agencyId,
    userIds,
    windowDays,
    now,
  });

  const seatCostCents = await resolveSeatCostCents(agencyId);

  const detected = computeFindings(grants, activity, manifestMap, {
    windowDays,
    now,
    seatCostCents,
  });

  const summary = summarize(detected, seatCostCents);

  logger.info(
    `[cost-optimization] agency=${agencyId} grants=${grants.length} users=${userIds.length} ` +
      `findings=${detected.length} savings=${summary.estimatedMonthlySavingsCents ?? 'unavailable'}`,
  );

  if (dryRun) {
    return {
      agencyId,
      grantCount: grants.length,
      userCount: userIds.length,
      findings: detected,
      categoryCounts: summary.categoryCounts,
      estimatedMonthlySavingsCents: summary.estimatedMonthlySavingsCents,
      written: 0,
      resolvedStale: 0,
    };
  }

  const { written, resolvedStale } = await writeFindingsForAgency(agencyId, detected);

  // Stamp the rate-limit column on agency_settings.
  await prisma.agency_settings.updateMany({
    where: { agency_id: agencyId },
    data: { last_cost_scan_at: now },
  });

  // Optional audit emission — host decides.
  if (publishAudit) {
    try {
      await publishAudit({
        type: 'cost.findings.refreshed',
        action: 'refreshed',
        actor: { id: 'system', email: 'system' },
        agency: { id: agencyId, slug: agencySlug || undefined },
        context: {
          agencyId,
          categoryCounts: summary.categoryCounts,
          estimatedMonthlySavingsCents: summary.estimatedMonthlySavingsCents,
          written,
          resolvedStale,
        },
      });
    } catch (err) {
      logger.warn(
        `[cost-optimization] agency=${agencyId} audit emit failed (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    agencyId,
    grantCount: grants.length,
    userCount: userIds.length,
    findings: detected,
    categoryCounts: summary.categoryCounts,
    estimatedMonthlySavingsCents: summary.estimatedMonthlySavingsCents,
    written,
    resolvedStale,
  };
}
