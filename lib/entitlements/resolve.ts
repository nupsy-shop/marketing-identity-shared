/**
 * Shared entitlement reader — DB-only, no Lago API, no Redis.
 *
 * Reads cached_entitlements from agency_settings (mirrored from Lago by
 * the web app's resolveEntitlements) and falls back to the shared
 * tier-policy-fallback static definitions when no cached data is available.
 *
 * This reader is safe to use from the Bull worker without Lago credentials.
 *
 * Import rules for shared submodule:
 * - Relative imports with .js extensions (ESM convention)
 * - No @/ alias imports
 */

import { getRuntime } from '../runtime.js';
import { getFeaturesForTier, getMaxPluginTierForTier } from '../lago/tier-policy-fallback.js';
import type { ResolvedEntitlements } from './types.js';

// ─── Fallback: Build from tier-policy-fallback static definitions ─────────────

function buildFallbackEntitlements(tier: string): ResolvedEntitlements {
  const features = getFeaturesForTier(tier);
  return {
    tier,
    planCode: null,
    limits: {
      maxClients: Infinity,
      maxUsers: Infinity,
      maxPlatforms: Infinity,
      retentionDays: 30,
      apiRateLimit: 0,
    },
    features: {
      ...features,
      auditVerify: true, // Always on — tamper-evident infrastructure
      apiTier: null,
    } as ResolvedEntitlements['features'],
    connectors: {
      tier1Enabled: getMaxPluginTierForTier(tier) >= 1,
      tier2Enabled: getMaxPluginTierForTier(tier) >= 2,
      tier3Enabled: getMaxPluginTierForTier(tier) >= 3,
    },
    extraSeatPriceCents: 1500,
    source: 'fallback',
  };
}

// ─── Main DB reader ──────────────────────────────────────────────────────────

/**
 * Resolve effective entitlements for an agency from the DB only.
 *
 * Resolution order:
 * 1. agency_settings.cached_entitlements — Lago snapshot mirrored by web app
 * 2. Tier-policy static fallback based on agency_settings.tier
 * 3. Free-tier fallback when agency is unknown
 *
 * This function is intentionally DB-only. It does NOT call the Lago API or
 * Redis cache — those live in lib/lago/entitlement-resolver.ts (web only).
 */
export async function resolveEntitlementsFromDb(agencyId: string): Promise<ResolvedEntitlements> {
  const { prisma } = getRuntime();

  const row = await prisma.agency_settings.findFirst({
    where: { agency_id: agencyId },
    select: {
      tier: true,
      cached_entitlements: true,
      cached_entitlements_at: true,
    },
  });

  if (!row) {
    return buildFallbackEntitlements('free');
  }

  const cached = row.cached_entitlements as ResolvedEntitlements | null;
  if (cached && typeof cached === 'object' && cached.tier) {
    return cached;
  }

  return buildFallbackEntitlements(row.tier || 'free');
}
