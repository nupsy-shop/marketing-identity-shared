/**
 * Offboarding evidence bundle (canonical).
 *
 * Computes the deterministic byte-stream for a single offboarding run by
 * collating run metadata, the impact snapshot the initiator saw at request
 * time, every step's status + artifact ids, and any manual tasks. The bytes
 * are RFC 8785 (JCS) — the same canonicalizer the audit publisher uses —
 * so re-derivation on read is byte-identical to the bytes that produced
 * the stored sha256.
 *
 * Used by:
 *   - The `client_offboard_finalize` Bull handler, which writes the hash
 *     to `offboarding_runs.sha256_hash` once the destructive steps complete.
 *   - The `GET /api/clients/[clientId]/offboard/runs/[runId]/evidence`
 *     endpoint, which re-hashes the live bundle and surfaces a tamper
 *     warning when the recomputed hash doesn't match the stored one.
 *
 * The function does NOT write anything — pure read + canonicalise + hash.
 * Callers are responsible for the `withTenantContext(agencyId, …)` guard.
 */

import { getRuntime } from '../runtime.js';
import { canonicalizeBody, sha256Hex } from '../audit/canonicalize.js';

export interface EvidenceBundle {
  schemaVersion: 1;
  run: {
    id: string;
    clientId: string;
    agencyId: string;
    initiatorUserId: string;
    approverUserId: string | null;
    reason: string;
    note: string | null;
    status: string;
    createdAt: string;
    approvedAt: string | null;
    completedAt: string | null;
  };
  client: {
    id: string;
    name: string;
    offboardedAt: string | null;
    offboardedBy: string | null;
    offboardedApprovedBy: string | null;
    offboardedReason: string | null;
    offboardedNote: string | null;
  };
  impactSnapshot: unknown;
  steps: Array<{
    stepKey: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    error: unknown;
    artifactIds: unknown;
  }>;
  manualTasks: Array<{
    id: string;
    platformKey: string;
    artifactType: string;
    artifactId: string;
    status: string;
    completedAt: string | null;
    completedBy: string | null;
  }>;
}

export interface EvidenceComputeResult {
  bundle: EvidenceBundle;
  bytes: Buffer;
  sha256: string;
}

/**
 * Compute the canonical evidence bundle for a run. Returns the bundle, its
 * canonical byte-stream, and the sha256 of those bytes.
 *
 * Throws if the run does not exist. Caller must be inside the appropriate
 * tenant context.
 */
export async function computeEvidenceBundle(runId: string): Promise<EvidenceComputeResult> {
  const { prisma } = getRuntime();

  const run = await prisma.offboarding_runs.findUnique({
    where: { id: runId },
    include: {
      clients: true,
      steps: { orderBy: { step_key: 'asc' } },
      manual_tasks: { orderBy: { id: 'asc' } },
    },
  });

  if (!run) {
    throw new Error(`offboarding_run ${runId} not found`);
  }

  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    run: {
      id: run.id,
      clientId: run.client_id,
      agencyId: run.agency_id,
      initiatorUserId: run.initiator_user_id,
      approverUserId: run.approver_user_id ?? null,
      reason: run.reason,
      note: run.note ?? null,
      status: run.status,
      createdAt: run.created_at.toISOString(),
      approvedAt: run.approved_at ? run.approved_at.toISOString() : null,
      completedAt: run.completed_at ? run.completed_at.toISOString() : null,
    },
    client: {
      id: run.clients.id,
      name: run.clients.name,
      offboardedAt: run.clients.offboarded_at ? run.clients.offboarded_at.toISOString() : null,
      offboardedBy: run.clients.offboarded_by ?? null,
      offboardedApprovedBy: run.clients.offboarded_approved_by ?? null,
      offboardedReason: run.clients.offboarded_reason ?? null,
      offboardedNote: run.clients.offboarded_note ?? null,
    },
    impactSnapshot: run.impact_snapshot ?? null,
    steps: (run.steps ?? []).map((s: any) => ({
      stepKey: s.step_key,
      status: s.status,
      startedAt: s.started_at ? s.started_at.toISOString() : null,
      completedAt: s.completed_at ? s.completed_at.toISOString() : null,
      error: s.error ?? null,
      artifactIds: s.artifact_ids ?? null,
    })),
    manualTasks: (run.manual_tasks ?? []).map((t: any) => ({
      id: t.id,
      platformKey: t.platform_key,
      artifactType: t.artifact_type,
      artifactId: t.artifact_id,
      status: t.status,
      completedAt: t.completed_at ? t.completed_at.toISOString() : null,
      completedBy: t.completed_by ?? null,
    })),
  };

  const canonical = canonicalizeBody(bundle);
  const bytes = Buffer.from(canonical, 'utf8');
  const sha256 = sha256Hex(bytes);
  return { bundle, bytes, sha256 };
}
