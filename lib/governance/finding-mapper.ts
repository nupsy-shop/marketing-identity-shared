/**
 * Finding Mapper
 *
 * Pure transformation that turns a governance `Recommendation` (+ the
 * `UserRisk` it was generated from) into a `FindingInput` — the persisted
 * shape used by the redesigned Permission Analysis "findings" feature.
 *
 * Kept side-effect free so it can be unit-tested in isolation and reused by
 * both the API persistence path and any export/report renderers.
 */

import { createHash } from 'node:crypto';
import type { Recommendation, UserRisk } from './recommendations.js';

export interface FindingInput {
  fingerprint: string;
  category: string;
  severity: 'critical' | 'warning' | 'info' | 'success';
  title: string;
  description: string;
  recommendation: string;
  principalType: string;
  principalId: string | null;
  principalLabel: string;
  principalRole: string | null;
  platformKey: string | null;
  platformLabel: string | null;
  frameworks: string[];
  evidence: string[];
  riskContribution: number | null;
}

/**
 * Deterministic fingerprint for a finding. Stable across runs so repeated
 * analyses upsert the same row, and unique per category + principal + platform
 * so distinct findings never collide.
 */
export function fingerprintFor(
  category: string,
  principalId: string,
  platformKey: string | null,
): string {
  return createHash('sha256')
    .update(`${category}|${principalId}|${platformKey ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

// Human-readable suggested action per recommendation type. The engine's
// `action` field is a machine API descriptor ({method, path, body}), not a
// sentence, so the UI's "recommended action" is derived from `type` here.
const ACTION_LABELS: Record<string, string> = {
  revoke_stale: 'Revoke stale access',
  reduce_scope: 'Reduce permission scope to least privilege',
  verify_access: 'Verify this access is still required',
  resolve_drift: 'Re-align grant to the expected policy',
  add_expiration: 'Wrap in a time-bound (expiring) grant',
};

const PLATFORM_LABELS: Record<string, string> = {
  hubspot: 'HubSpot',
  meta: 'Meta',
  ga4: 'GA4',
  'google-ads': 'Google Ads',
  google_ads: 'Google Ads',
  salesforce: 'Salesforce',
  klaviyo: 'Klaviyo',
  shopify: 'Shopify',
  linkedin: 'LinkedIn',
  pinterest: 'Pinterest',
  tiktok: 'TikTok',
};

export function recommendationToFindingInput(
  rec: Recommendation,
  user: UserRisk,
): FindingInput {
  const platformKey = rec.targetPlatformKey ?? null;
  return {
    fingerprint: fingerprintFor(rec.category, rec.targetUserId, platformKey),
    category: rec.category,
    severity: rec.severity,
    title: rec.description,
    description: rec.evidence[0] ?? rec.description,
    recommendation: ACTION_LABELS[rec.type] ?? 'Review and remediate',
    principalType: 'user',
    principalId: rec.targetUserId,
    principalLabel: user.name || user.email,
    principalRole: user.role ?? null,
    platformKey,
    platformLabel: platformKey ? (PLATFORM_LABELS[platformKey] ?? platformKey) : null,
    frameworks: rec.frameworks as unknown as string[],
    evidence: rec.evidence,
    riskContribution: user.riskScore ?? null,
  };
}
