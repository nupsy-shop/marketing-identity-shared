/**
 * Policy loader for the remediation engine.
 *
 * Extracted from `remediation-engine.ts` as part of issue #91. Reads the
 * per-trigger `remediationPolicies[triggerType]` block out of
 * `agency_settings`. Callers are responsible for not calling this in a hot
 * loop (the original engine made one call per evaluation).
 */

import { getRuntime } from '../runtime.js';
import type {
  RemediationPolicies,
  RemediationPolicy,
  PolicyShape,
} from './remediation-types.js';

export type { PolicyShape, RemediationPolicy, RemediationPolicies };

/**
 * Load the full `remediationPolicies` block for an agency. Returns an empty
 * object if settings are missing (same defaulting behaviour the original
 * engine had inline).
 */
export async function loadPolicies(agencyId: string): Promise<RemediationPolicies> {
  const { prisma } = getRuntime();
  const row = await prisma.agency_settings.findFirst({
    where: { agency_id: agencyId },
    select: { remediation_policies: true },
  });
  return (row?.remediation_policies as unknown as RemediationPolicies) || {};
}

/**
 * Load the policy for a specific trigger type. Returns `undefined` if no
 * policy is configured — callers treat that as implicit `manual`.
 */
export async function loadPolicy(
  agencyId: string,
  triggerType: string,
): Promise<RemediationPolicy | undefined> {
  const policies = await loadPolicies(agencyId);
  return policies[triggerType] as RemediationPolicy | undefined;
}

