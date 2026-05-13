/**
 * Credential Rotation Engine (shared) — issue #51 follow-up.
 *
 * Handles credential rotation paths across both the web app and the
 * bull worker:
 *   - `autoRotateOnCheckin` — triggered when a session grant is
 *     revoked (Shared Credential only).
 *   - `manualRotate` — triggered from the web UI button (both SC and
 *     SA, SA requires confirmed flag).
 *   - `rotateIdentityCredentialShared` — triggered by the bull
 *     `rotate_credential_for_identity` worker for scheduled rotations.
 *
 * Scope (locked by follow-up):
 *   - Vault + rotation **selection** + **audit-emit** layer only.
 *   - Per-platform rotation providers (e.g. "rotate Shopify app
 *     password") are OUT of scope for this port. A registry lookup
 *     returns `null` for unimplemented providers; the scheduled path
 *     no-ops with `rotation_skipped: provider_not_implemented` audit.
 *
 * Invariants:
 *   - Prisma only; every query filters by agency when possible.
 *   - Audit payloads carry IDs + timestamps + reason codes only.
 *     NEVER passwords, keys, vault paths, or raw identity metadata.
 *   - Framework-agnostic: Prisma from `getRuntime()`. No `@/lib/...`
 *     imports.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { IdentityType } from '../provisioning-types.js';
import { rotateCredential } from './vault.js';

// ─── Identity lookup ────────────────────────────────────────────────────────

interface IdentityRow {
  id: string;
  identityType: string;
  username: string | null;
  rotationPolicy: Record<string, unknown>;
  credentialType: string | null;
  vaultSecretPath: string | null;
  agencyId: string;
  platformKey: string | null;
  isActive: boolean;
}

/**
 * Look up an identity, scoped to the caller's agency.
 *
 * The shared runtime exposes the **raw** Prisma client (not the
 * tenant-middleware-wrapped one), so this helper MUST filter by
 * `agency_id` explicitly. A `findUnique({ where: { id } })` here would
 * silently leak cross-agency rows and let a cross-agency rotate spoof
 * either succeed against the wrong vault or 500 downstream instead of
 * cleanly returning "not found" (#1164).
 */
async function getIdentityById(
  identityId: string,
  actorAgencyId: string,
): Promise<IdentityRow | null> {
  const { prisma } = getRuntime();
  const row = await prisma.integration_identities.findFirst({
    where: { id: identityId, agency_id: actorAgencyId },
  });
  if (!row) return null;
  const metadata = (row.metadata || {}) as Record<string, unknown>;
  return {
    id:              row.id,
    identityType:    row.type,
    username:        row.identifier,
    rotationPolicy:  (metadata.rotation_policy || {}) as Record<string, unknown>,
    credentialType:  (metadata.credential_type as string | null) || null,
    vaultSecretPath: (metadata.vault_secret_path as string | null) || null,
    agencyId:        row.agency_id,
    platformKey:     row.platform_key ?? null,
    isActive:        !!row.isActive,
  };
}

// ─── Provider registry (placeholder) ────────────────────────────────────────
//
// Per-platform rotation providers (e.g. "rotate Shopify app password")
// are intentionally unimplemented here. When a caller asks for one,
// return null so the scheduled path can emit a typed skip audit.
//
// Adding a provider later: export a map keyed by platform_key +
// credential_type, each entry `async (identity) => { ... }`. Callers
// will stop receiving `provider_not_implemented` for covered pairs.

export type RotationProvider = (identity: IdentityRow) => Promise<{ rotated: boolean } | null>;

export function lookupRotationProvider(
  _platformKey: string | null,
  _credentialType: string | null,
): RotationProvider | null {
  // Intentionally no providers registered. See doc-comment above.
  return null;
}

// ─── Skip-reason enum ───────────────────────────────────────────────────────

export const ROTATION_SKIP_REASONS = {
  IDENTITY_NOT_FOUND:       'identity_not_found',
  IDENTITY_DISABLED:        'identity_disabled',
  MANUAL_ONLY_POLICY:       'manual_only_policy',
  AUTO_ROTATE_DISABLED:     'auto_rotate_disabled',
  NOT_APPLICABLE:           'not_applicable',
  ROTATE_FAILED:            'rotate_failed',
  PROVIDER_NOT_IMPLEMENTED: 'provider_not_implemented',
  NO_CREDENTIAL:            'no_credential',
} as const;

export type RotationSkipReason =
  (typeof ROTATION_SKIP_REASONS)[keyof typeof ROTATION_SKIP_REASONS];

// ─── Audit emission helpers ─────────────────────────────────────────────────
//
// publishAuditEvent is the shared entry point (ES + hash chain). We
// NEVER include password/key/vault-path text in any payload.

async function emitAuto(params: {
  agencyId: string;
  identityId: string;
  grantId?: string;
  previousLastRotatedAt: unknown;
  actor?: string;
}): Promise<void> {
  await publishAuditEvent({
    eventType: 'identity.credential.auto_rotated',
    source: 'rotation-engine',
    severity: 'info',
    agency: { id: params.agencyId },
    actor: { id: params.actor || 'system:rotation-engine', type: params.actor ? 'user' : 'system' },
    resource: { type: 'integration_identity', id: params.identityId },
    context: {
      identityId: params.identityId,
      grantId: params.grantId ?? null,
      previousLastRotatedAt: params.previousLastRotatedAt ?? null,
    },
  }).catch(() => { /* non-fatal */ });
}

async function emitManual(params: {
  agencyId: string;
  identityId: string;
  identityType: string;
  credentialType: string | null;
  previousLastRotatedAt: unknown;
  actor?: string;
  triggeredBy?: string;
}): Promise<void> {
  await publishAuditEvent({
    eventType: 'identity.credential.rotated',
    source: 'rotation-engine',
    severity: 'info',
    agency: { id: params.agencyId },
    actor: { id: params.actor || 'system:rotation-engine', type: params.actor ? 'user' : 'system' },
    resource: { type: 'integration_identity', id: params.identityId },
    context: {
      identityId: params.identityId,
      identityType: params.identityType,
      credentialType: params.credentialType,
      triggeredBy: params.triggeredBy ?? 'manual',
      previousLastRotatedAt: params.previousLastRotatedAt ?? null,
    },
  }).catch(() => { /* non-fatal */ });
}

async function emitSkipped(params: {
  agencyId: string;
  identityId: string;
  identityType: string | null;
  platformKey: string | null;
  reason: RotationSkipReason;
  triggeredBy?: string;
  grantId?: string;
}): Promise<void> {
  await publishAuditEvent({
    eventType: 'identity.credential.rotation_skipped',
    source: 'rotation-engine',
    severity: 'info',
    agency: { id: params.agencyId },
    actor: { id: 'system:rotation-engine', type: 'system' },
    resource: { type: 'integration_identity', id: params.identityId },
    context: {
      identityId:   params.identityId,
      identityType: params.identityType,
      platformKey:  params.platformKey,
      triggeredBy:  params.triggeredBy ?? null,
      grantId:      params.grantId ?? null,
      reason:       params.reason,
    },
  }).catch(() => { /* non-fatal */ });
}

// ─── Auto-Rotate on Check-in ────────────────────────────────────────────────

export interface AutoRotateContext {
  /**
   * Agency id of the caller. REQUIRED — used to scope the identity
   * lookup so a cross-agency identityId can't be probed. See #1164.
   */
  actorAgencyId: string;
  grantId?: string;
  actorEmail?: string;
}

export interface AutoRotateResult {
  rotated: boolean;
  reason?: string;
}

/**
 * Called when a session grant is revoked (check-in). If the identity
 * is a Shared Credential with `autoRotateOnCheckin`, rotate the
 * password.
 */
export async function autoRotateOnCheckin(
  identityId: string,
  context: AutoRotateContext,
): Promise<AutoRotateResult> {
  const identity = await getIdentityById(identityId, context.actorAgencyId);
  if (!identity) return { rotated: false, reason: ROTATION_SKIP_REASONS.IDENTITY_NOT_FOUND };

  // Service Account: never auto-rotate.
  if (identity.identityType === IdentityType.SERVICE_ACCOUNT) {
    await emitSkipped({
      agencyId:     identity.agencyId,
      identityId,
      identityType: identity.identityType,
      platformKey:  identity.platformKey,
      reason:       ROTATION_SKIP_REASONS.MANUAL_ONLY_POLICY,
      triggeredBy:  'checkin',
      grantId:      context.grantId,
    });
    return { rotated: false, reason: ROTATION_SKIP_REASONS.MANUAL_ONLY_POLICY };
  }

  if (identity.identityType === IdentityType.SHARED_CREDENTIAL) {
    const policy = identity.rotationPolicy || {};
    if (!policy.autoRotateOnCheckin) {
      return { rotated: false, reason: ROTATION_SKIP_REASONS.AUTO_ROTATE_DISABLED };
    }

    const previousLastRotatedAt = (policy as Record<string, unknown>).lastRotatedAt || null;
    const result = await rotateCredential(identityId);
    if (!result) return { rotated: false, reason: ROTATION_SKIP_REASONS.ROTATE_FAILED };

    await emitAuto({
      agencyId: identity.agencyId,
      identityId,
      grantId: context.grantId,
      previousLastRotatedAt,
      actor: context.actorEmail,
    });

    return { rotated: true };
  }

  // Human Interactive (or other) — no credential to rotate.
  return { rotated: false, reason: ROTATION_SKIP_REASONS.NOT_APPLICABLE };
}

// ─── Manual Rotation ────────────────────────────────────────────────────────

export interface ManualRotateOptions {
  /**
   * Agency id of the operator triggering the rotation. REQUIRED — used
   * to scope the identity lookup so a cross-agency identityId returns
   * `Identity not found` (404) instead of leaking / 500ing. See #1164.
   */
  actorAgencyId: string;
  actorEmail?: string;
  confirmed?: boolean;
}

export interface ManualRotateResult {
  success: boolean;
  error?: string;
  message?: string;
  rotatedAt?: string;
}

/**
 * Manually rotate a credential. For Service Account identities the
 * caller must pass `confirmed: true` (enforced at the API layer with a
 * danger dialog).
 */
export async function manualRotate(
  identityId: string,
  { actorAgencyId, actorEmail, confirmed = false }: ManualRotateOptions,
): Promise<ManualRotateResult> {
  const identity = await getIdentityById(identityId, actorAgencyId);
  if (!identity) return { success: false, error: 'Identity not found' };

  if (identity.identityType === IdentityType.HUMAN_INTERACTIVE) {
    return {
      success: false,
      error: 'Human Interactive identities do not have stored credentials to rotate',
    };
  }

  if (identity.identityType === IdentityType.SERVICE_ACCOUNT && !confirmed) {
    return {
      success: false,
      error: 'CONFIRMATION_REQUIRED',
      message:
        'This will invalidate the current credential and may break active integrations using it. Are you sure?',
    };
  }

  const previousLastRotatedAt =
    (identity.rotationPolicy as Record<string, unknown>)?.lastRotatedAt || null;
  const result = await rotateCredential(identityId);
  if (!result) return { success: false, error: 'No credential found to rotate' };

  await emitManual({
    agencyId:              identity.agencyId,
    identityId,
    identityType:          identity.identityType,
    credentialType:        identity.credentialType,
    previousLastRotatedAt,
    actor:                 actorEmail,
    triggeredBy:           'manual',
  });

  return { success: true, rotatedAt: result.rotatedAt };
}

// ─── Scheduled rotation (bull worker entry point) ───────────────────────────

export interface RotateIdentityCredentialInput {
  agencyId: string;
  identityId: string;
  triggeredBy?: string;
}

export interface RotateIdentityCredentialResult {
  status: 'rotated' | 'skipped' | 'failed';
  reason?: RotationSkipReason;
}

/**
 * Entry point for the bull `rotate_credential_for_identity` worker.
 *
 * Selects the appropriate rotation path based on identity type and
 * provider registry. When no per-platform provider is registered for
 * a Service Account, emits a `provider_not_implemented` skip audit
 * and returns `status: 'skipped'` — this matches the locked scope
 * ("providers can be ported later per-platform").
 *
 * Shared Credential identities rotate through the generic vault
 * password envelope (no per-platform hook required).
 */
export async function rotateIdentityCredentialShared(
  input: RotateIdentityCredentialInput,
): Promise<RotateIdentityCredentialResult> {
  const { agencyId, identityId, triggeredBy = 'scheduled' } = input;

  // Identity lookup is scoped to `agencyId` (#1164). The defence-in-
  // depth `identity.agencyId !== agencyId` check below is now dead in
  // the happy path but kept as a belt-and-braces guard against future
  // refactors of getIdentityById.
  const identity = await getIdentityById(identityId, agencyId);
  if (!identity) {
    await emitSkipped({
      agencyId,
      identityId,
      identityType: null,
      platformKey: null,
      reason: ROTATION_SKIP_REASONS.IDENTITY_NOT_FOUND,
      triggeredBy,
    });
    return { status: 'skipped', reason: ROTATION_SKIP_REASONS.IDENTITY_NOT_FOUND };
  }

  // Enforce that the identity belongs to the agency the scheduler said
  // it does. Defence-in-depth — the scheduler already scopes by agency.
  if (identity.agencyId !== agencyId) {
    await emitSkipped({
      agencyId,
      identityId,
      identityType: identity.identityType,
      platformKey:  identity.platformKey,
      reason:       ROTATION_SKIP_REASONS.IDENTITY_NOT_FOUND,
      triggeredBy,
    });
    return { status: 'skipped', reason: ROTATION_SKIP_REASONS.IDENTITY_NOT_FOUND };
  }

  if (!identity.isActive) {
    await emitSkipped({
      agencyId:     identity.agencyId,
      identityId,
      identityType: identity.identityType,
      platformKey:  identity.platformKey,
      reason:       ROTATION_SKIP_REASONS.IDENTITY_DISABLED,
      triggeredBy,
    });
    return { status: 'skipped', reason: ROTATION_SKIP_REASONS.IDENTITY_DISABLED };
  }

  // SHARED_CREDENTIAL: rotate the vault password envelope directly.
  if (identity.identityType === IdentityType.SHARED_CREDENTIAL) {
    const previousLastRotatedAt =
      (identity.rotationPolicy as Record<string, unknown>)?.lastRotatedAt || null;
    const result = await rotateCredential(identityId);
    if (!result) {
      await emitSkipped({
        agencyId:     identity.agencyId,
        identityId,
        identityType: identity.identityType,
        platformKey:  identity.platformKey,
        reason:       ROTATION_SKIP_REASONS.NO_CREDENTIAL,
        triggeredBy,
      });
      return { status: 'skipped', reason: ROTATION_SKIP_REASONS.NO_CREDENTIAL };
    }

    await emitManual({
      agencyId:              identity.agencyId,
      identityId,
      identityType:          identity.identityType,
      credentialType:        identity.credentialType,
      previousLastRotatedAt,
      triggeredBy,
    });

    return { status: 'rotated' };
  }

  // SERVICE_ACCOUNT: per-platform provider required. No provider
  // registered in this port — emit a typed skip and return.
  if (identity.identityType === IdentityType.SERVICE_ACCOUNT) {
    const provider = lookupRotationProvider(identity.platformKey, identity.credentialType);
    if (!provider) {
      await emitSkipped({
        agencyId:     identity.agencyId,
        identityId,
        identityType: identity.identityType,
        platformKey:  identity.platformKey,
        reason:       ROTATION_SKIP_REASONS.PROVIDER_NOT_IMPLEMENTED,
        triggeredBy,
      });
      return {
        status: 'skipped',
        reason: ROTATION_SKIP_REASONS.PROVIDER_NOT_IMPLEMENTED,
      };
    }

    const providerResult = await provider(identity);
    if (!providerResult || !providerResult.rotated) {
      await emitSkipped({
        agencyId:     identity.agencyId,
        identityId,
        identityType: identity.identityType,
        platformKey:  identity.platformKey,
        reason:       ROTATION_SKIP_REASONS.ROTATE_FAILED,
        triggeredBy,
      });
      return { status: 'skipped', reason: ROTATION_SKIP_REASONS.ROTATE_FAILED };
    }

    await emitManual({
      agencyId:              identity.agencyId,
      identityId,
      identityType:          identity.identityType,
      credentialType:        identity.credentialType,
      previousLastRotatedAt: (identity.rotationPolicy as Record<string, unknown>)?.lastRotatedAt || null,
      triggeredBy,
    });
    return { status: 'rotated' };
  }

  // HUMAN_INTERACTIVE or unknown type — nothing to rotate.
  await emitSkipped({
    agencyId:     identity.agencyId,
    identityId,
    identityType: identity.identityType,
    platformKey:  identity.platformKey,
    reason:       ROTATION_SKIP_REASONS.NOT_APPLICABLE,
    triggeredBy,
  });
  return { status: 'skipped', reason: ROTATION_SKIP_REASONS.NOT_APPLICABLE };
}
