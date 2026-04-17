/**
 * Offboarding evidence utility.
 *
 * Produces a deterministic, canonical JSON serialization of an offboarding run +
 * its side-effect steps + manual-task ledger, plus a sha256 hex digest of that
 * canonical bytes. Downstream:
 *   - Phase 2 `client_offboard_finalize` job stores the hash on the run record.
 *   - Phase 3 Evidence view re-derives the bundle and compares against the
 *     stored hash to surface tamper warnings.
 *
 * The canonical serializer guarantees:
 *   - Object keys are serialized in ascending Unicode order at every depth.
 *   - Arrays preserve input order (arrays are semantic, not sets).
 *   - `undefined`-valued keys are dropped (JSON doesn't represent `undefined`).
 *   - Dates → ISO-8601 strings via their `toISOString()`.
 *   - Finite numbers round-trip exactly as `JSON.stringify` formats them.
 *     Non-finite numbers (`NaN`, `±Infinity`) are rejected to guarantee
 *     byte-for-byte determinism across platforms.
 *
 * This module is intentionally dependency-free so both the Next app and the
 * BullMQ worker can import it without pulling in Prisma or Node-only deps.
 */

import { createHash } from 'crypto';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EvidenceRun {
  id: string;
  clientId: string;
  agencyId: string;
  initiatorUserId: string;
  approverUserId: string | null;
  reason: string;
  note: string | null;
  status: string;
  impactSnapshot: unknown;
  createdAt: string | Date;
  approvedAt: string | Date | null;
  completedAt: string | Date | null;
}

export interface EvidenceStep {
  id: string;
  stepKey: string;
  status: string;
  startedAt: string | Date | null;
  completedAt: string | Date | null;
  error: unknown;
  artifactIds: unknown;
}

export interface EvidenceManualTask {
  id: string;
  platformKey: string;
  artifactType: string;
  artifactId: string;
  context: unknown;
  ownerUserId: string | null;
  status: string;
  completedAt: string | Date | null;
  completedBy: string | null;
}

export interface EvidenceBundle {
  schemaVersion: 1;
  run: EvidenceRun;
  steps: EvidenceStep[];
  manualTasks: EvidenceManualTask[];
}

// ── Canonical JSON ───────────────────────────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Cannot canonicalize non-finite number for evidence bundle');
    }
    return value;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  // string | boolean | bigint — bigint is not JSON-serializable, leave to JSON.stringify to throw
  return value;
}

/**
 * Build the deterministic canonical JSON string for an offboarding run.
 *
 * Key order is sorted, `undefined` is stripped, dates become ISO strings.
 * Same inputs → byte-identical output across machines and runs.
 */
export function buildCanonicalBundle(
  run: EvidenceRun,
  steps: EvidenceStep[],
  manualTasks: EvidenceManualTask[],
): string {
  // Sort steps + manual-tasks by id to remove DB-ordering as a failure mode.
  const sortedSteps = [...steps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedTasks = [...manualTasks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bundle: EvidenceBundle = {
    schemaVersion: 1,
    run,
    steps: sortedSteps,
    manualTasks: sortedTasks,
  };

  return JSON.stringify(canonicalize(bundle));
}

/**
 * Hex-encoded sha256 of a canonical JSON string.
 */
export function sha256(canonicalJson: string): string {
  return createHash('sha256').update(canonicalJson, 'utf8').digest('hex');
}
