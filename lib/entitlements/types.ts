/**
 * Entitlement types shared between the web app and the Bull worker.
 *
 * The shape mirrors the output of mapLagoEntitlements in
 * lib/lago/entitlement-resolver.ts — any changes there must be reflected here.
 */

export interface EntitlementLimits {
  maxClients: number;
  maxUsers: number;
  maxPlatforms: number;
  retentionDays: number;
  apiRateLimit: number;
}

export interface EntitlementFeatures {
  sso: boolean;
  pamGovernance: boolean;
  driftDetection: boolean;
  certifications: boolean;
  breakGlassAccess: boolean;
  segregationOfDuties: boolean;
  complianceReports: boolean;
  clientTrustReports: boolean;
  auditExport: boolean;
  credentialRotation: boolean;
  auditVerify: boolean;
  jmlAutomation: boolean;
  contractorManagement: boolean;
  timeBoundAccess: boolean;
  campaignScopedAccess: boolean;
  sessionRecording: boolean;
  permissionAnalysis: boolean;
  accessAnalytics: boolean;
  scimProvisioning: boolean;
  customRoles: boolean;
  workflowEngine: boolean;
  advancedWorkflows: boolean;
  bulkImport: boolean;
  clientOnboardingKit: boolean;
  autoRemediation: boolean;
  autoRemediationFull: boolean;
  costOptimization: boolean;
  apiTier: string | null;
  partnerDelegation: boolean;
  [key: string]: unknown;
}

export interface EntitlementConnectors {
  tier1Enabled: boolean;
  tier2Enabled: boolean;
  tier3Enabled: boolean;
}

export interface EntitlementIdentities {
  agencyOwned: boolean;
  agencyOwnedMax: number;
  clientDedicated: boolean;
  clientDedicatedMax: number;
}

export interface EntitlementAccessPatterns {
  namedInvite: boolean;
  partnerDelegation: boolean;
  groupAccess: boolean;
  sharedAccount: boolean;
  apiToken: boolean;
}

export interface ResolvedEntitlements {
  tier: string;
  planCode: string | null;
  limits: EntitlementLimits;
  features: EntitlementFeatures;
  connectors: EntitlementConnectors;
  identities?: EntitlementIdentities;
  accessPatterns?: EntitlementAccessPatterns;
  extraSeatPriceCents: number;
  source: 'lago' | 'fallback';
}
