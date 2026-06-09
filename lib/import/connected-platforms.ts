// shared/lib/import/connected-platforms.ts
// Registry-free replacement for ensurePluginsLoaded() + PluginRegistry.get()
// (#1405 P3). A connected agency_platforms row whose related catalog_platforms
// row carries a slug already implies a known plugin, so we derive the by-key
// map straight from the DB — no web plugin registry.
//
// pluginKey in the web registry === catalog_platforms.slug, and an
// agency_platforms.platformId IS the catalog_platforms.id (see web
// lib/db/platforms.ts:getAllAgencyPlatforms + lib/plugins resolution). The
// registry-free analog of "non-null plugin key" is "the related catalog row
// has a slug". Scoped by agency_id (no RLS in the worker) and excludes
// soft-deleted rows (deletedAt: null) to match "connected".
import { getRuntime } from '../runtime.js';

export interface ConnectedPlatform {
  pluginKey: string;
  platformId: string;
  agencyPlatformId: string;
}

export async function getConnectedPlatformsByKey(
  agencyId: string,
): Promise<Map<string, ConnectedPlatform>> {
  const { prisma } = getRuntime();
  const rows: Array<{
    id: string;
    platformId: string;
    catalog_platforms: { slug: string | null } | null;
  }> = await prisma.agency_platforms.findMany({
    where: { agency_id: agencyId, deletedAt: null },
    select: {
      id: true,
      platformId: true,
      catalog_platforms: { select: { slug: true } },
    },
  });

  const map = new Map<string, ConnectedPlatform>();
  for (const r of rows) {
    const pluginKey = r.catalog_platforms?.slug;
    if (!pluginKey) continue;
    map.set(pluginKey, {
      pluginKey,
      platformId: r.platformId,
      agencyPlatformId: r.id,
    });
  }
  return map;
}
