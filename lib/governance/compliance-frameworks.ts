/**
 * Compliance Frameworks Mapping
 *
 * Single source of truth for:
 *  1. Which roles are excluded from permission-analysis risk scoring
 *     (agency owners hold full access by design — flagging them creates audit noise).
 *  2. Mapping recommendation categories to the control frameworks
 *     (SOC 2 / ISO 27001 / GDPR) they satisfy, so auditors can trace
 *     each finding back to a specific control.
 *
 * Framework control ids referenced here:
 *  - SOC 2 (AICPA TSC 2017): CC6.x (Logical Access), CC7.x (System Operations)
 *    https://www.aicpa.org/resources/download/2017-trust-services-criteria
 *  - ISO/IEC 27001:2022 Annex A: A.5 (Organizational), A.8 (Technological)
 *    https://www.iso.org/standard/27001
 *  - GDPR (EU 2016/679) Articles 5, 25, 32
 *    https://gdpr-info.eu/
 *
 * Framework strings are the ones the page/export consume — keep them aligned with
 * the summary card chip rendering.
 */

// ─── Excluded roles ──────────────────────────────────────────────────────────

/**
 * Roles that hold full-access by design and must not be flagged as risk.
 * `agency_owner` is the primary case; add `system_admin` etc. here if introduced.
 */
export const RISK_EXCLUDED_ROLES = ['agency_owner'] as const;

export type ExcludedRole = (typeof RISK_EXCLUDED_ROLES)[number];

export function isExcludedFromRiskAnalysis(role: string | null | undefined): boolean {
  if (!role) return false;
  return (RISK_EXCLUDED_ROLES as readonly string[]).includes(role);
}

// ─── Recommendation categories ───────────────────────────────────────────────

/**
 * Human-readable categories used to group findings in the UI roll-up.
 * Each recommendation maps to exactly one category.
 */
export const RECOMMENDATION_CATEGORIES = {
  EXCESSIVE_ADMIN_ACCESS: 'Excessive Admin Access',
  STALE_ACCESS: 'Stale Access',
  UNVERIFIED_ACCESS: 'Unverified Access',
  SOD_CONFLICT: 'SoD Conflict',
  DRIFT_DETECTED: 'Drift Detected',
  MISSING_EXPIRATION: 'Missing Expiration',
} as const;

export type RecommendationCategory =
  (typeof RECOMMENDATION_CATEGORIES)[keyof typeof RECOMMENDATION_CATEGORIES];

export const FRAMEWORKS = ['SOC2', 'ISO27001', 'GDPR'] as const;
export type ComplianceFramework = (typeof FRAMEWORKS)[number];

/**
 * Category → frameworks map.
 *
 * Sources:
 *  - SOC 2 TSC 2017 — CC6.1/CC6.2/CC6.3 (logical access), CC7.2 (monitoring).
 *  - ISO 27001:2022 Annex A — A.5.15 (access control), A.5.18 (access rights),
 *    A.8.2 (privileged access), A.8.3 (information access restriction).
 *  - GDPR — Art. 5(1)(f) integrity/confidentiality, Art. 25 data protection by
 *    design, Art. 32 security of processing.
 *
 * Audit/compliance teams tune this file, not the UI.
 */
export const RECOMMENDATION_FRAMEWORK_MAP: Record<
  RecommendationCategory,
  ComplianceFramework[]
> = {
  [RECOMMENDATION_CATEGORIES.EXCESSIVE_ADMIN_ACCESS]: ['SOC2', 'ISO27001', 'GDPR'],
  [RECOMMENDATION_CATEGORIES.STALE_ACCESS]: ['SOC2', 'ISO27001', 'GDPR'],
  [RECOMMENDATION_CATEGORIES.UNVERIFIED_ACCESS]: ['SOC2', 'ISO27001'],
  [RECOMMENDATION_CATEGORIES.SOD_CONFLICT]: ['SOC2', 'ISO27001'],
  [RECOMMENDATION_CATEGORIES.DRIFT_DETECTED]: ['SOC2', 'ISO27001', 'GDPR'],
  [RECOMMENDATION_CATEGORIES.MISSING_EXPIRATION]: ['SOC2', 'ISO27001'],
};

export function frameworksForCategory(
  category: RecommendationCategory,
): ComplianceFramework[] {
  return RECOMMENDATION_FRAMEWORK_MAP[category] ?? [];
}
