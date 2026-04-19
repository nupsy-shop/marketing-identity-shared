/**
 * Contractor policy helpers (issue #55) — shared.
 *
 * Reads/writes the `contractor_policy` JSONB column on `agency_settings`.
 * Shape is intentionally tiny and flat so the Prisma schema default carries
 * the authoritative defaults (no code-side fallbacks).
 */

import { getRuntime } from '../runtime.js';

export interface ContractorPolicy {
  maxContractDays: number;
  noticeWindowDays: number;
  autoOffboardDefault: boolean;
}

/**
 * Read the agency's contractor policy. The Prisma-level default on
 * agency_settings.contractor_policy supplies the canonical defaults, so
 * callers never need in-code fallbacks.
 */
export async function getContractorPolicy(agencyId: string): Promise<ContractorPolicy> {
  const { prisma } = getRuntime();
  const row = await prisma.agency_settings.findFirst({
    where: { agency_id: agencyId },
    select: { contractor_policy: true },
  });
  if (!row) {
    throw new Error(`No agency_settings row for agency ${agencyId}`);
  }
  const raw = (row.contractor_policy ?? {}) as Record<string, unknown>;
  return {
    maxContractDays: Number(raw.maxContractDays),
    noticeWindowDays: Number(raw.noticeWindowDays),
    autoOffboardDefault: Boolean(raw.autoOffboardDefault),
  };
}

/**
 * Upsert the contractor policy for an agency. Prisma merges at the column
 * level; we pass the full policy object (JSONB replace semantics).
 */
export async function updateContractorPolicy(
  agencyId: string,
  patch: Partial<ContractorPolicy>,
): Promise<ContractorPolicy> {
  const { prisma } = getRuntime();
  const current = await getContractorPolicy(agencyId);
  const next: ContractorPolicy = {
    maxContractDays: patch.maxContractDays ?? current.maxContractDays,
    noticeWindowDays: patch.noticeWindowDays ?? current.noticeWindowDays,
    autoOffboardDefault: patch.autoOffboardDefault ?? current.autoOffboardDefault,
  };
  if (!Number.isFinite(next.maxContractDays) || next.maxContractDays <= 0) {
    throw new Error('maxContractDays must be a positive integer');
  }
  if (!Number.isFinite(next.noticeWindowDays) || next.noticeWindowDays <= 0) {
    throw new Error('noticeWindowDays must be a positive integer');
  }

  await prisma.agency_settings.updateMany({
    where: { agency_id: agencyId },
    data: { contractor_policy: next as unknown as object, updated_at: new Date() },
  });
  return next;
}
