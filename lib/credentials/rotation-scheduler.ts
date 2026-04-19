/**
 * Credential Rotation Scheduler (shared, per-agency) — issue #51.
 *
 * Orchestrator-only: this shared helper selects identities due for
 * rotation and enqueues a per-identity `rotate_credential_for_identity`
 * job through the host's `enqueueJob` runtime service. It never writes
 * secrets, never talks to the vault, and never imports rotation-engine.
 *
 * Rotation itself remains authoritative on the web side:
 *   lib/credential-vault.ts + lib/rotation-engine.ts (KMS/vault clients,
 *   per-identity-type rotation providers). Wiring the
 *   `rotate_credential_for_identity` handler on the web app is a
 *   separate follow-up; this port covers the scheduling pipeline only.
 *
 * Invariants:
 *   - Prisma only (no raw SQL).
 *   - Every query filters on `agencyId`.
 *   - Audit payloads carry IDs + reason codes + timestamps only.
 *     NEVER passwords, keys, vault paths, or raw identity metadata.
 *   - Entitlement gating is optional (caller-supplied). When not
 *     entitled, emits ONE `rotation_skipped` with reason `not_entitled`
 *     per scan (never per identity).
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Cadence values the product accepts. Any write (per-identity or agency
 * default) outside this set must be rejected at the API layer with
 * `invalid_cadence`.
 */
export const ALLOWED_CADENCE_DAYS: readonly number[] = [7, 30, 60, 90] as const;

export function isAllowedCadence(value: unknown): value is number {
  return typeof value === 'number' && ALLOWED_CADENCE_DAYS.includes(value);
}

/**
 * Enum of reasons a scheduler iteration may skip an identity. Emitted in
 * the `identity.credential.rotation_skipped` audit event payload.
 */
export const SKIP_REASONS = {
  IDENTITY_DISABLED:    'identity_disabled',
  VAULT_WRITE_FAILED:   'vault_write_failed',
  NOT_ENTITLED:         'not_entitled',
  CONNECTION_DEGRADED:  'connection_degraded',
  POLICY_DISABLED:      'policy_disabled',
  ENQUEUE_FAILED:       'enqueue_failed',
} as const;

export type SkipReason = (typeof SKIP_REASONS)[keyof typeof SKIP_REASONS];

/**
 * Identity types the scheduler is allowed to rotate.
 * Mirrors shared/lib/provisioning-types.ts IdentityType enum.
 */
const ROTATABLE_TYPES: readonly string[] = [
  'SHARED_CREDENTIAL',
  'SERVICE_ACCOUNT',
];

/**
 * Fallback default used only when both per-identity and agency settings are
 * missing — mirrors the Prisma `@default(30)` on
 * `agency_settings.security_config.credentialRotationDays`.
 */
export const PRISMA_DEFAULT_CADENCE_DAYS = 30;

// ─── Cadence Resolution ─────────────────────────────────────────────────────

interface IdentityCadenceInput {
  rotation_cadence_days?: number | null;
}

interface AgencyDefaultInput {
  credentialRotationDays?: number | null;
}

/**
 * Cadence resolution: per-identity > agency default > Prisma default.
 */
export function resolveCadenceDays(
  identity: IdentityCadenceInput | null | undefined,
  agencyDefault: AgencyDefaultInput | null | undefined,
): number {
  const perIdentity = identity?.rotation_cadence_days;
  if (typeof perIdentity === 'number' && perIdentity > 0) return perIdentity;
  const perAgency = agencyDefault?.credentialRotationDays;
  if (typeof perAgency === 'number' && perAgency > 0) return perAgency;
  return PRISMA_DEFAULT_CADENCE_DAYS;
}

export function computeNextRotationAt(now: Date, cadenceDays: number): Date {
  const next = new Date(now.getTime());
  next.setUTCDate(next.getUTCDate() + cadenceDays);
  return next;
}

// ─── Selection ──────────────────────────────────────────────────────────────

export interface DueIdentityRow {
  id: string;
  type: string;
  platform_key: string | null;
  isActive: boolean;
  rotation_cadence_days: number | null;
  last_rotated_at: Date | null;
  next_rotation_at: Date | null;
}

/**
 * Select SC/SA identities within a single agency whose `next_rotation_at`
 * has elapsed.
 *
 * HUMAN_INTERACTIVE and API_KEY identities are filtered out at query time.
 * An identity with `next_rotation_at IS NULL` is treated as "never rotated"
 * and is eligible.
 */
export async function selectIdentitiesDueForRotation(
  agencyId: string,
  now: Date,
): Promise<DueIdentityRow[]> {
  const { prisma } = getRuntime();
  const rows = await prisma.integration_identities.findMany({
    where: {
      agency_id: agencyId,
      type: { in: ROTATABLE_TYPES as string[] },
      OR: [
        { next_rotation_at: null },
        { next_rotation_at: { lte: now } },
      ],
    },
    select: {
      id: true,
      type: true,
      platform_key: true,
      isActive: true,
      rotation_cadence_days: true,
      last_rotated_at: true,
      next_rotation_at: true,
    },
  });
  return rows as DueIdentityRow[];
}

// ─── Audit helpers ──────────────────────────────────────────────────────────

export async function emitAgencyNotEntitled(agencyId: string): Promise<void> {
  await publishAuditEvent({
    eventType: 'identity.credential.rotation_skipped',
    source: 'rotation-scheduler',
    severity: 'info',
    agency: { id: agencyId },
    actor: { id: 'system:rotation-scheduler', type: 'system' },
    context: { scope: 'agency', reason: SKIP_REASONS.NOT_ENTITLED },
  }).catch(() => { /* non-fatal */ });
}

async function emitSkipped(params: {
  agencyId: string;
  identityId: string;
  identityType: string;
  platformKey: string | null;
  cadenceDays: number;
  reason: SkipReason;
}): Promise<void> {
  await publishAuditEvent({
    eventType: 'identity.credential.rotation_skipped',
    source: 'rotation-scheduler',
    severity: 'info',
    agency: { id: params.agencyId },
    actor: { id: 'system:rotation-scheduler', type: 'system' },
    resource: { type: 'integration_identity', id: params.identityId },
    context: {
      identityId:   params.identityId,
      identityType: params.identityType,
      platformKey:  params.platformKey,
      cadenceDays:  params.cadenceDays,
      reason:       params.reason,
    },
  }).catch(() => { /* non-fatal */ });
}

// ─── Scan (orchestrator) ────────────────────────────────────────────────────

export interface ScanCredentialsDueForRotationOptions {
  agencyId: string;
  now?: Date;
  /**
   * Optional entitlement gate. When provided and it returns false, the
   * scan short-circuits with a single `rotation_skipped` audit with
   * reason `not_entitled`.
   */
  isEntitled?: (agencyId: string) => Promise<boolean>;
}

export interface ScanCredentialsResult {
  status: 'skipped' | 'completed';
  reason?: 'not_entitled';
  enqueued: number;
  skipped: Record<SkipReason, number>;
  scanned: number;
}

function emptySkippedCounters(): Record<SkipReason, number> {
  return {
    identity_disabled: 0,
    vault_write_failed: 0,
    not_entitled: 0,
    connection_degraded: 0,
    policy_disabled: 0,
    enqueue_failed: 0,
  };
}

/**
 * Scan for identities due for rotation in a single agency and enqueue one
 * `rotate_credential_for_identity` job per identity that should rotate.
 *
 * Returns aggregate counters; audit events are emitted for every skip.
 * Never throws — per-identity errors are counted and logged.
 */
export async function scanCredentialsDueForRotation(
  opts: ScanCredentialsDueForRotationOptions,
): Promise<ScanCredentialsResult> {
  const { prisma, logger, enqueueJob } = getRuntime();
  const now = opts.now ?? new Date();
  const skipped = emptySkippedCounters();

  if (opts.isEntitled) {
    let entitled = false;
    try {
      entitled = await opts.isEntitled(opts.agencyId);
    } catch (err) {
      logger.warn('rotation-scheduler: entitlement resolve failed', {
        agencyId: opts.agencyId,
        err: err instanceof Error ? err.message : String(err),
      });
      entitled = false;
    }
    if (!entitled) {
      await emitAgencyNotEntitled(opts.agencyId);
      return {
        status: 'skipped',
        reason: 'not_entitled',
        enqueued: 0,
        skipped,
        scanned: 0,
      };
    }
  }

  // Agency-default cadence from security_config (JSON column). Read via
  // Prisma only — Prisma's `@default` supplies the canonical value when
  // the row exists, so no code-side fallback is needed here.
  const settings = await prisma.agency_settings.findFirst({
    where: { agency_id: opts.agencyId },
    select: { security_config: true },
  });
  const securityConfig = (settings?.security_config ?? {}) as Record<string, unknown>;
  const agencyDefault: AgencyDefaultInput = {
    credentialRotationDays:
      typeof securityConfig.credentialRotationDays === 'number'
        ? (securityConfig.credentialRotationDays as number)
        : null,
  };

  const due = await selectIdentitiesDueForRotation(opts.agencyId, now);
  let enqueued = 0;

  for (const identity of due) {
    const cadenceDays = resolveCadenceDays(
      { rotation_cadence_days: identity.rotation_cadence_days },
      agencyDefault,
    );

    // Defensive: type should already be SC/SA from the query filter.
    if (!ROTATABLE_TYPES.includes(identity.type)) {
      skipped.policy_disabled++;
      await emitSkipped({
        agencyId: opts.agencyId,
        identityId: identity.id,
        identityType: identity.type,
        platformKey: identity.platform_key,
        cadenceDays,
        reason: SKIP_REASONS.POLICY_DISABLED,
      });
      continue;
    }

    if (!identity.isActive) {
      skipped.identity_disabled++;
      await emitSkipped({
        agencyId: opts.agencyId,
        identityId: identity.id,
        identityType: identity.type,
        platformKey: identity.platform_key,
        cadenceDays,
        reason: SKIP_REASONS.IDENTITY_DISABLED,
      });
      continue;
    }

    if (!enqueueJob) {
      skipped.enqueue_failed++;
      logger.warn('rotation-scheduler: enqueueJob runtime service unavailable', {
        agencyId: opts.agencyId,
        identityId: identity.id,
      });
      await emitSkipped({
        agencyId: opts.agencyId,
        identityId: identity.id,
        identityType: identity.type,
        platformKey: identity.platform_key,
        cadenceDays,
        reason: SKIP_REASONS.ENQUEUE_FAILED,
      });
      continue;
    }

    try {
      await enqueueJob('rotate_credential_for_identity', {
        tenantId: opts.agencyId,
        identityId: identity.id,
        triggeredBy: 'scheduled',
      });
      enqueued++;
    } catch (err) {
      skipped.enqueue_failed++;
      logger.warn('rotation-scheduler: enqueue failed', {
        agencyId: opts.agencyId,
        identityId: identity.id,
        err: err instanceof Error ? err.message : String(err),
      });
      await emitSkipped({
        agencyId: opts.agencyId,
        identityId: identity.id,
        identityType: identity.type,
        platformKey: identity.platform_key,
        cadenceDays,
        reason: SKIP_REASONS.ENQUEUE_FAILED,
      });
    }
  }

  logger.info('rotation-scheduler: scan complete', {
    agencyId: opts.agencyId,
    scanned: due.length,
    enqueued,
    skipped,
  });

  return {
    status: 'completed',
    enqueued,
    skipped,
    scanned: due.length,
  };
}
