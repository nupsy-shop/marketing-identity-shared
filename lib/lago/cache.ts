/**
 * Lago entitlement cache — framework-agnostic readers.
 *
 * The web-side `lib/lago/entitlement-resolver.ts` writes a snapshot of
 * `ResolvedEntitlements` into `agency_settings.cached_entitlements` after
 * every successful upstream Lago fetch. This module lets the bull worker
 * (which has no Lago client) consult that snapshot.
 *
 * When the cache is empty or stale, callers fall back to `tier-policy`
 * (the same hardcoded per-tier defaults web uses when Lago is
 * unreachable).
 *
 * Shape of `cached_entitlements` mirrors the web-side `ResolvedEntitlements`
 * interface — only the subset bull workers actually read is typed here
 * to keep the shared surface narrow.
 */

import { getRuntime } from '../runtime.js';

interface CachedEntitlements {
  source?: 'lago' | 'fallback';
  features?: Record<string, boolean>;
  extraSeatPriceCents?: number;
  tier?: string;
}

/**
 * Read a single feature flag from the cached entitlements row. Returns
 * `null` when no cache row exists yet — callers decide whether to fall
 * back to a tier-policy default or treat absence as "not entitled".
 */
export async function getCachedFeatureFlag(
  agencyId: string,
  featureKey: string,
): Promise<boolean | null> {
  const { prisma } = getRuntime();
  const row = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
    select: { cached_entitlements: true },
  });
  const cached = (row?.cached_entitlements ?? null) as CachedEntitlements | null;
  if (!cached || !cached.features) return null;
  const value = cached.features[featureKey];
  if (typeof value !== 'boolean') return null;
  return value;
}

/**
 * Read the cached seat-cost-cents. `null` means the cache is empty OR the
 * resolved source was `fallback` (i.e. Lago was unreachable at last
 * sync) — callers must treat `null` as "cost unavailable" and never
 * substitute 0, matching the web-side contract at
 * `lib/lago/entitlement-resolver.ts::getSeatCostCents`.
 */
export async function getCachedSeatCostCents(agencyId: string): Promise<number | null> {
  const { prisma } = getRuntime();
  const row = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
    select: { cached_entitlements: true },
  });
  const cached = (row?.cached_entitlements ?? null) as CachedEntitlements | null;
  if (!cached || cached.source !== 'lago') return null;
  const cents = Number(cached.extraSeatPriceCents);
  if (!Number.isFinite(cents) || cents <= 0) return null;
  return cents;
}

/**
 * Read the cached tier (agency's plan). Never null unless the agency
 * settings row itself is missing. Used by the bull worker as a
 * last-resort input to tier-policy when the full cache isn't populated
 * yet (new agency, fresh deploy).
 */
export async function getCachedTier(agencyId: string): Promise<string | null> {
  const { prisma } = getRuntime();
  const row = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
    select: { tier: true },
  });
  return row?.tier ?? null;
}
