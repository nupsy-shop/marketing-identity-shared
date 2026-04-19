/**
 * Static role-category manifest map for the cost-optimization scanner.
 *
 * Replaces the web-only dynamic `IdentityPluginRegistry` lookup from
 * `marketing-identity/lib/cost-optimization/manifest-map.ts`. Both hosts
 * (the web app's nightly scheduler script and the per-agency Bull worker)
 * now consume the same static JSON so the shared code stays
 * framework-agnostic.
 *
 * Platforms whose `pluginKey` is absent from the JSON bucket as
 * 'uncategorized' in `categoryFor()` — NEVER silently flagged as
 * duplicate / over-provisioned. To extend: add an entry to
 * `role-categories.json` keyed by `pluginKey`.
 */

import type { ManifestMap, RoleCategoryEntry } from './types.js';
import { createRequire } from 'node:module';

// Dynamic require() keeps this file portable across both the web app
// (moduleResolution: bundler, excludes shared from tsc) and the Bull
// worker (NodeNext with resolveJsonModule). The JSON lives next to this
// module in the shared tree.
const require_ = createRequire(import.meta.url);
const rawJson = require_('./role-categories.json') as Record<string, unknown>;

function sanitize(raw: Record<string, unknown>): ManifestMap {
  const out: ManifestMap = {};
  for (const [pluginKey, roleMap] of Object.entries(raw)) {
    // Skip meta keys like "$schema" / "$comment".
    if (pluginKey.startsWith('$')) continue;
    if (!roleMap || typeof roleMap !== 'object') continue;
    const mapped: Record<string, RoleCategoryEntry> = {};
    for (const [roleSlug, entry] of Object.entries(roleMap as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object') continue;
      const cat = (entry as { category?: unknown }).category;
      if (cat !== 'admin' && cat !== 'editor' && cat !== 'read_only' && cat !== 'uncategorized') {
        continue;
      }
      const readonly = Boolean((entry as { readonly?: unknown }).readonly);
      mapped[roleSlug] = { category: cat, readonly };
    }
    out[pluginKey] = mapped;
  }
  return out;
}

const STATIC_MAP: ManifestMap = sanitize(rawJson);

export function buildRoleCategoryManifestMap(): ManifestMap {
  return STATIC_MAP;
}
