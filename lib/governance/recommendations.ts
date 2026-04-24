/**
 * Recommendations Engine
 *
 * Generates actionable, auditor-ready recommendations from risk data.
 *
 * Each recommendation carries:
 *  - id / severity / targetUserId / description / action (as before)
 *  - category       — human-readable grouping (e.g. "Stale Access")
 *  - frameworks[]   — compliance controls the finding touches (SOC2/ISO27001/GDPR)
 *  - evidence[]     — audit-cite-able strings (e.g. "92 days since last activity")
 *
 * The framework mapping comes from `./compliance-frameworks.ts`, which is the
 * single place compliance/audit teams tune — never inline control ids here.
 */

import crypto from 'crypto';
import {
  RECOMMENDATION_CATEGORIES,
  frameworksForCategory,
  isExcludedFromRiskAnalysis,
  type ComplianceFramework,
  type RecommendationCategory,
} from './compliance-frameworks.js';

// --- Types -------------------------------------------------------------------

type RecommendationType =
  | 'revoke_stale'
  | 'reduce_scope'
  | 'verify_access'
  | 'resolve_drift'
  | 'add_expiration';

type Severity = 'critical' | 'warning' | 'info';

interface RecommendationAction {
  method: string;
  path: string;
  body: Record<string, unknown>;
}

export interface Recommendation {
  id: string;
  type: RecommendationType;
  severity: Severity;
  description: string;
  action: RecommendationAction;
  targetUserId: string;
  targetPlatformKey: string | null;
  /** Human-readable grouping used by the right-rail UI and the CSV export. */
  category: RecommendationCategory;
  /** Compliance controls this finding maps to (subset of SOC2/ISO27001/GDPR). */
  frameworks: ComplianceFramework[];
  /** Short cite-able evidence strings for auditors and report rows. */
  evidence: string[];
}

export interface RiskFactor {
  type: string;
  score: number;
  detail?: string;
}

export interface UserRisk {
  userId: string;
  email: string;
  name: string;
  riskScore: number;
  factors: RiskFactor[];
  platforms: string[];
  lastActivity: string | null;
  /**
   * Optional role copy so downstream filters can defensively re-apply the
   * owner exclusion. `computeUserRiskScores` already filters at the data
   * layer but we want belt-and-suspenders in `generateRecommendations`.
   */
  role?: string | null;
}

// --- Recommendation Types ----------------------------------------------------

const TYPES: Record<string, RecommendationType> = {
  REVOKE_STALE: 'revoke_stale',
  REDUCE_SCOPE: 'reduce_scope',
  VERIFY_ACCESS: 'verify_access',
  RESOLVE_DRIFT: 'resolve_drift',
  ADD_EXPIRATION: 'add_expiration',
};

// --- Generator ---------------------------------------------------------------

const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };

interface BuildArgs {
  type: RecommendationType;
  severity: Severity;
  category: RecommendationCategory;
  description: string;
  action: RecommendationAction;
  targetUserId: string;
  targetPlatformKey: string | null;
  evidence: string[];
}

function build(args: BuildArgs): Recommendation {
  return {
    id: crypto.randomUUID(),
    type: args.type,
    severity: args.severity,
    category: args.category,
    description: args.description,
    action: args.action,
    targetUserId: args.targetUserId,
    targetPlatformKey: args.targetPlatformKey,
    frameworks: frameworksForCategory(args.category),
    evidence: args.evidence,
  };
}

/**
 * Generate recommendations from user risk data.
 *
 * Users whose role is excluded from risk analysis (e.g. `agency_owner`) are
 * skipped defensively — the risk scorer should never emit them in the first
 * place, but we never want an owner to slip into a recommendation.
 */
export function generateRecommendations(userRisks: UserRisk[]): Recommendation[] {
  const recommendations: Recommendation[] = [];

  for (const user of userRisks) {
    if (isExcludedFromRiskAnalysis(user.role)) continue;

    for (const factor of user.factors) {
      switch (factor.type) {
        case 'inactivity': {
          if (factor.score >= 10) {
            const daysMatch = factor.detail?.match(/(\d+) days/);
            const days = daysMatch ? daysMatch[1] : '90+';
            for (const platform of user.platforms) {
              recommendations.push(build({
                type: TYPES.REVOKE_STALE,
                severity: factor.score >= 20 ? 'critical' : 'warning',
                category: RECOMMENDATION_CATEGORIES.STALE_ACCESS,
                description: `Revoke ${platform} access for ${user.email} \u2014 no activity in ${days} days`,
                action: { method: 'POST', path: '/api/agency/permission-analysis/remediate', body: { type: 'revoke', userId: user.userId, platformKey: platform } },
                targetUserId: user.userId,
                targetPlatformKey: platform,
                evidence: [
                  `No recorded activity on ${platform} for ${days} days`,
                  user.lastActivity
                    ? `Last activity: ${user.lastActivity}`
                    : 'No activity events found in the 90-day audit window',
                ],
              }));
            }
          }
          break;
        }

        case 'admin_roles': {
          if (user.platforms.length >= 3) {
            const adminMatch = factor.detail?.match(/(\d+)/);
            const adminCount = adminMatch ? adminMatch[1] : String(user.platforms.length);
            recommendations.push(build({
              type: TYPES.REDUCE_SCOPE,
              severity: 'warning',
              category: RECOMMENDATION_CATEGORIES.EXCESSIVE_ADMIN_ACCESS,
              description: `${user.email} has admin access to ${user.platforms.length} platforms \u2014 consider viewer role`,
              action: { method: 'POST', path: '/api/agency/permission-analysis/remediate', body: { type: 'reduce_scope', userId: user.userId } },
              targetUserId: user.userId,
              targetPlatformKey: null,
              evidence: [
                `${adminCount} admin/elevated role(s) across ${user.platforms.length} platforms`,
                `Platforms: ${user.platforms.join(', ')}`,
              ],
            }));
          }
          break;
        }

        case 'missing_verification': {
          const countMatch = factor.detail?.match(/(\d+)/);
          const count = countMatch ? countMatch[1] : '?';
          const daysAgo = 90; // approximate
          recommendations.push(build({
            type: TYPES.VERIFY_ACCESS,
            severity: 'info',
            category: RECOMMENDATION_CATEGORIES.UNVERIFIED_ACCESS,
            description: `${count} access items for ${user.email} haven't been verified in ${daysAgo} days`,
            action: { method: 'POST', path: '/api/agency/permission-analysis/remediate', body: { type: 'verify', userId: user.userId } },
            targetUserId: user.userId,
            targetPlatformKey: null,
            evidence: [
              `${count} access item(s) pending verification`,
              `Verification window: ${daysAgo} days`,
            ],
          }));
          break;
        }

        case 'drift_detected': {
          for (const platform of user.platforms) {
            recommendations.push(build({
              type: TYPES.RESOLVE_DRIFT,
              severity: 'critical',
              category: RECOMMENDATION_CATEGORIES.DRIFT_DETECTED,
              description: `Unauthorized access detected on ${platform} for ${user.email}`,
              action: { method: 'POST', path: '/api/agency/permission-analysis/remediate', body: { type: 'resolve_drift', userId: user.userId, platformKey: platform } },
              targetUserId: user.userId,
              targetPlatformKey: platform,
              evidence: [
                `Drift event recorded on ${platform}`,
                factor.detail || 'Drift detected in audit stream',
              ],
            }));
          }
          break;
        }

        case 'no_expiration': {
          const countMatch = factor.detail?.match(/(\d+)/);
          const count = countMatch ? countMatch[1] : '?';
          recommendations.push(build({
            type: TYPES.ADD_EXPIRATION,
            severity: 'info',
            category: RECOMMENDATION_CATEGORIES.MISSING_EXPIRATION,
            description: `${user.email} has ${count} permanent access items \u2014 consider adding expiration`,
            action: { method: 'POST', path: '/api/agency/permission-analysis/remediate', body: { type: 'add_expiration', userId: user.userId } },
            targetUserId: user.userId,
            targetPlatformKey: null,
            evidence: [
              `${count} access item(s) without an expiration date`,
            ],
          }));
          break;
        }
      }
    }
  }

  // Sort: critical first, then warning, then info
  recommendations.sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3));

  // Limit to top 20 recommendations
  return recommendations.slice(0, 20);
}
