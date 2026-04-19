/**
 * Canonical role-category slugs used by Access Analytics (#59) and
 * Cost Optimization (#58). Plugin manifests expose `roleCategories`
 * as `RoleCategoryMap` (platform-role-slug → canonical category).
 *
 * Plugins without a manifest map surface as an EXPLICIT
 * `uncategorized` row in the concentration heatmap — never silently
 * dropped.
 *
 * This file lives in shared so both the web app and the Bull worker
 * aggregators import one type. The web-repo
 * `plugins/identity/common/identity-plugin.interface.ts` re-exports
 * these symbols for existing callers.
 */

export type RoleCategorySlug =
  | 'admin'
  | 'editor'
  | 'read_only'
  | 'billing'
  | 'developer'
  | 'uncategorized'
  | string; // forward-compat: unknown slugs flow through

/**
 * Map from a platform-specific role slug (e.g. 'owner', 'store_manager')
 * to a canonical category slug.
 */
export type RoleCategoryMap = Record<string, RoleCategorySlug>;
