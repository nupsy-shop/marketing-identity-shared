/**
 * Provisioning Types — shared across app and bull worker
 *
 * Single source of truth for provisioning status values,
 * identity types, and ownership models.
 */

// ── Identity type ───────────────────────────────────────────────────────────

export const IdentityType = {
  HUMAN_INTERACTIVE: 'HUMAN_INTERACTIVE',
  SERVICE_ACCOUNT: 'SERVICE_ACCOUNT',
  SHARED_CREDENTIAL: 'SHARED_CREDENTIAL',
} as const;

export type IdentityType = (typeof IdentityType)[keyof typeof IdentityType];

// ── Identity ownership ──────────────────────────────────────────────────────

export const IdentityOwnership = {
  AGENCY: 'AGENCY',
  CLIENT_DEDICATED: 'CLIENT_DEDICATED',
} as const;

export type IdentityOwnership = (typeof IdentityOwnership)[keyof typeof IdentityOwnership];

// ── Provider-level status (per-provider within an identity) ─────────────────

export const ProviderStatus = {
  PENDING: 'PENDING',
  PROVISIONED: 'PROVISIONED',
  SKIPPED: 'SKIPPED',
  ERROR: 'ERROR',
} as const;

export type ProviderStatus = (typeof ProviderStatus)[keyof typeof ProviderStatus];

// ── Identity-level status (overall provisioning_status) ─────────────────────

export const IdentityProvisioningStatus = {
  PENDING: 'PENDING',
  PROVISIONED: 'PROVISIONED',
  ERROR: 'ERROR',
} as const;

export type IdentityProvisioningStatus = (typeof IdentityProvisioningStatus)[keyof typeof IdentityProvisioningStatus];

// ── Provider entry in provisioning_providers_status JSON ─────────────────────

export interface ProviderStatusEntry {
  status: ProviderStatus;
  updatedAt?: string;
  externalId?: string | null;
  jobId?: string | null;
  error?: string | null;
  reason?: string | null;
}

export type ProvidersStatusMap = Record<string, ProviderStatusEntry>;

// ── Terminal check helpers ───────────────────────────────────────────────────

export function isTerminalProviderStatus(status: string): boolean {
  return status === ProviderStatus.PROVISIONED || status === ProviderStatus.SKIPPED;
}

export function isProviderProvisioned(status: string): boolean {
  return status === ProviderStatus.PROVISIONED;
}
