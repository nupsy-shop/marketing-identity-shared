/**
 * Tier-policy fallback (framework-agnostic subset).
 *
 * Mirrors the feature-flag portion of web's `lib/tier-policy.ts` so the
 * bull worker can resolve entitlements when the agency_settings entitlement
 * cache is empty (new agency or fresh deploy before the first Lago sync).
 *
 * Per-tier flags below MUST stay in lockstep with web's `TIER_POLICIES`.
 * The web resolver's fallback branch at
 * `lib/lago/entitlement-resolver.ts::buildFallbackEntitlements` is the
 * canonical source; this file carries the same values for worker use.
 *
 * Any tier-policy change on web should land a matching edit here in the
 * same PR, or the bull worker will silently use stale values.
 */

export type TierFeatures = Readonly<{
  sso: boolean;
  pamGovernance: boolean;
  jmlAutomation: boolean;
  timeBoundAccess: boolean;
  sessionRecording: boolean;
  breakGlassAccess: boolean;
  auditExport: boolean;
  auditVerify: boolean;
  autoRemediation: boolean;
  customRoles: boolean;
  scimProvisioning: boolean;
  bulkImport: boolean;
  workflowEngine: boolean;
  advancedWorkflows: boolean;
  certifications: boolean;
  complianceReports: boolean;
  permissionAnalysis: boolean;
  partnerDelegation: boolean;
  driftDetection: boolean;
  segregationOfDuties: boolean;
  credentialRotation: boolean;
  contractorManagement: boolean;
  clientTrustReports: boolean;
  costOptimization: boolean;
  accessAnalytics: boolean;
  campaignScopedAccess: boolean;
  clientOnboardingKit: boolean;
  [key: string]: boolean;
}>;

const FREE: TierFeatures = Object.freeze({
  sso: false, pamGovernance: false, jmlAutomation: false, timeBoundAccess: false,
  sessionRecording: false, breakGlassAccess: false, auditExport: false,
  auditVerify: true, autoRemediation: false, customRoles: false, scimProvisioning: false,
  bulkImport: false, workflowEngine: false, advancedWorkflows: false,
  certifications: false, complianceReports: false, permissionAnalysis: false,
  partnerDelegation: false, driftDetection: false, segregationOfDuties: false,
  credentialRotation: false, contractorManagement: false, clientTrustReports: false,
  costOptimization: false, accessAnalytics: false, campaignScopedAccess: false,
  clientOnboardingKit: false,
});

const STARTER: TierFeatures = Object.freeze({
  ...FREE,
  timeBoundAccess: true, bulkImport: true,
});

const GROWTH: TierFeatures = Object.freeze({
  ...STARTER,
  sso: true, pamGovernance: true, autoRemediation: true, customRoles: true,
  scimProvisioning: true, auditExport: true, breakGlassAccess: true,
  credentialRotation: true, clientTrustReports: true,
  campaignScopedAccess: true,
});

const BUSINESS: TierFeatures = Object.freeze({
  ...GROWTH,
  jmlAutomation: true, sessionRecording: true, workflowEngine: true,
  advancedWorkflows: true, certifications: true, complianceReports: true,
  permissionAnalysis: true, driftDetection: true, segregationOfDuties: true,
  contractorManagement: true, costOptimization: true, accessAnalytics: true,
  clientOnboardingKit: true,
});

const ENTERPRISE: TierFeatures = Object.freeze({
  ...BUSINESS,
  partnerDelegation: true,
});

const TIERS: Record<string, TierFeatures> = Object.freeze({
  free: FREE,
  starter: STARTER,
  growth: GROWTH,
  business: BUSINESS,
  enterprise: ENTERPRISE,
});

/**
 * Maximum connector plugin tier per subscription tier.
 *
 * Mirrors `TIER_DEFINITIONS[tier].maxPluginTier` from web's
 * `lib/tier-policy.ts`. Single source of truth for the shared submodule.
 *
 * free=1, starter=1, growth=2, business=3, enterprise=3
 */
const MAX_PLUGIN_TIER: Record<string, number> = Object.freeze({
  free: 1,
  starter: 1,
  growth: 2,
  business: 3,
  enterprise: 3,
});

/**
 * Return the per-tier feature-flag defaults. Unknown tier → 'free' (most
 * restrictive), matching web's fallback behaviour.
 */
export function getFeaturesForTier(tier: string): TierFeatures {
  return TIERS[tier] ?? FREE;
}

/**
 * Return the maximum connector plugin tier for a subscription tier.
 * Unknown tier → 0 (most restrictive), so all connector flags default to false.
 */
export function getMaxPluginTierForTier(tier: string): number {
  return MAX_PLUGIN_TIER[tier] ?? 0;
}
