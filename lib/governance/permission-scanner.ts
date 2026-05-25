/**
 * Permission Scan Engine (Phase 1)
 *
 * Runs a single Permission Analysis scan for an agency:
 *   1. Compute user risk scores + the agency risk summary.
 *   2. Generate recommendations and map them to persisted `FindingInput`s.
 *   3. Upsert findings against the currently-open set, keyed by fingerprint:
 *        - new fingerprint  -> create (state 'open', stable PA-### ref)
 *        - seen fingerprint -> update mutable fields, keep ref + state
 *        - open-but-unseen  -> resolve (state 'resolved', resolved_at)
 *   4. Stamp the parent scan row with the run summary.
 *   5. Emit a best-effort completion audit event.
 *
 * `generateRecommendations` is synchronous (returns an array), so it is not
 * awaited — matching the real signature in `./recommendations.ts`.
 */

import { getRuntime } from '../runtime.js';
import { computeUserRiskScores, computeRiskSummary } from './risk-scorer.js';
import { generateRecommendations } from './recommendations.js';
import { recommendationToFindingInput, type FindingInput } from './finding-mapper.js';
import { publishAuditEvent } from '../audit/publisher.js';

export interface PermissionScanResult {
  scanId: string;
  findingsTotal: number;
  findingsNew: number;
  findingsResolved: number;
}

/**
 * Build a monotonic ref allocator. Refs are `PA-<n>` where `n` continues past
 * the highest existing ref so references stay stable and never collide.
 */
function nextRef(existingRefs: string[]): (i: number) => string {
  const max = existingRefs.reduce(
    (m, r) => Math.max(m, parseInt(String(r).replace('PA-', ''), 10) || 0),
    0,
  );
  return (i: number) => `PA-${max + 1 + i}`;
}

export async function runPermissionScan(
  agencyId: string,
  opts: { scanId: string; trigger: 'manual'; userId?: string },
): Promise<PermissionScanResult> {
  const { prisma } = getRuntime();
  const startedMs = Date.now();

  const userRisks = await computeUserRiskScores(agencyId);
  const summary = await computeRiskSummary(agencyId);
  const recs = generateRecommendations(userRisks);
  const byUser = new Map(userRisks.map(u => [u.userId, u]));

  const inputs: FindingInput[] = recs
    .map(r => {
      const u = byUser.get(r.targetUserId);
      return u ? recommendationToFindingInput(r, u) : null;
    })
    .filter((x): x is FindingInput => x !== null);

  const open = await prisma.permission_findings.findMany({
    where: { agency_id: agencyId, state: 'open' },
  });
  const openByFp = new Map(
    open.map((f: { fingerprint: string }) => [f.fingerprint, f]),
  );
  const refFor = nextRef(open.map((f: { ref: string }) => f.ref));

  const seen = new Set<string>();
  let findingsNew = 0;
  let newIdx = 0;
  const now = new Date();

  for (const inp of inputs) {
    seen.add(inp.fingerprint);
    const existing = openByFp.get(inp.fingerprint) as { id: string } | undefined;
    const common = {
      category: inp.category,
      severity: inp.severity,
      title: inp.title,
      description: inp.description,
      recommendation: inp.recommendation,
      principal_type: inp.principalType,
      principal_id: inp.principalId,
      principal_label: inp.principalLabel,
      principal_role: inp.principalRole,
      platform_key: inp.platformKey,
      platform_label: inp.platformLabel,
      frameworks: inp.frameworks,
      evidence: inp.evidence,
      risk_contribution: inp.riskContribution,
      last_seen_at: now,
      last_scan_id: opts.scanId,
    };
    if (existing) {
      await prisma.permission_findings.update({ where: { id: existing.id }, data: common });
    } else {
      findingsNew++;
      await prisma.permission_findings.create({
        data: {
          agency_id: agencyId,
          ref: refFor(newIdx++),
          fingerprint: inp.fingerprint,
          state: 'open',
          first_detected_at: now,
          ...common,
        },
      });
    }
  }

  let findingsResolved = 0;
  for (const f of open as { id: string; fingerprint: string }[]) {
    if (!seen.has(f.fingerprint)) {
      findingsResolved++;
      await prisma.permission_findings.update({
        where: { id: f.id },
        data: { state: 'resolved', resolved_at: now },
      });
    }
  }

  const findingsTotal = open.length - findingsResolved + findingsNew;
  await prisma.permission_scans.update({
    where: { id: opts.scanId },
    data: {
      status: 'ok',
      completed_at: now,
      duration_ms: Date.now() - startedMs,
      findings_total: findingsTotal,
      findings_new: findingsNew,
      findings_resolved: findingsResolved,
      grants_analyzed: summary.userCount ?? null,
      platforms_analyzed: null,
    },
  });

  await publishAuditEvent({
    eventType: 'governance.permission_scan.completed',
    source: 'accesshive',
    actor: { id: opts.userId ?? 'system', email: null, type: 'user' },
    agency: { id: agencyId },
    context: { scanId: opts.scanId, findingsTotal, findingsNew, findingsResolved },
  }).catch(() => {});

  return { scanId: opts.scanId, findingsTotal, findingsNew, findingsResolved };
}
