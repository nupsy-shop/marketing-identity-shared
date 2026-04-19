/**
 * Access-analytics concentration aggregator (#59).
 *
 * Pure function. Given:
 *   - a flat list of grant rows ((platformKey, role, userId) per row),
 *   - a manifest-derived map of role-categories per platform,
 *   - the total unique-user count in the agency,
 * returns a deterministic list of cells:
 *   { platformKey, roleCategory, userCount, concentrationScore }.
 *
 * `concentrationScore = userCount / totalUsersInAgency` — the formula is
 * PUBLIC. Operators justify these numbers to auditors.
 *
 * Platforms whose manifest has no roleCategories map surface as an
 * EXPLICIT row with roleCategory "uncategorized" — silent exclusion
 * corrupts concentration analysis.
 */

import type { RoleCategoryMap, RoleCategorySlug } from './role-categories.js';

export const UNCATEGORIZED_ROLE_CATEGORY: RoleCategorySlug = 'uncategorized';

export interface ConcentrationGrant {
  platformKey: string;
  role: string;
  userId: string;
}

export interface ConcentrationCell {
  platformKey: string;
  roleCategory: RoleCategorySlug;
  userCount: number;
  concentrationScore: number;
  /** Tooltip-ready formula string — operators must be able to reason about the math. */
  formula: string;
}

export interface BuildConcentrationArgs {
  grants: ConcentrationGrant[];
  manifestMap: Record<string, RoleCategoryMap | undefined>;
  totalUsersInAgency: number;
}

/**
 * Bucket the platform role slug into its canonical category, or
 * "uncategorized" if the platform or role is unmapped.
 */
export function categorize(
  platformKey: string,
  role: string,
  manifestMap: Record<string, RoleCategoryMap | undefined>,
): RoleCategorySlug {
  const map = manifestMap[platformKey];
  if (!map) return UNCATEGORIZED_ROLE_CATEGORY;

  if (map[role]) return map[role];

  const lower = String(role).toLowerCase();
  for (const key of Object.keys(map)) {
    if (key.toLowerCase() === lower) return map[key];
  }

  return UNCATEGORIZED_ROLE_CATEGORY;
}

/**
 * Build the deterministic cell list. Sorted by (platformKey, roleCategory)
 * ascending; ties broken by insertion order (stable sort).
 */
export function buildConcentration(args: BuildConcentrationArgs): ConcentrationCell[] {
  const { grants, manifestMap, totalUsersInAgency } = args;

  const cellUsers: Map<string, Map<string, Set<string>>> = new Map();

  for (const g of grants) {
    const category = categorize(g.platformKey, g.role, manifestMap);
    let byCategory = cellUsers.get(g.platformKey);
    if (!byCategory) {
      byCategory = new Map();
      cellUsers.set(g.platformKey, byCategory);
    }
    let users = byCategory.get(category);
    if (!users) {
      users = new Set();
      byCategory.set(category, users);
    }
    users.add(g.userId);
  }

  const cells: ConcentrationCell[] = [];
  const platformKeys = [...cellUsers.keys()].sort();
  for (const platformKey of platformKeys) {
    const byCategory = cellUsers.get(platformKey)!;
    const categoryKeys = [...byCategory.keys()].sort();
    for (const roleCategory of categoryKeys) {
      const userCount = byCategory.get(roleCategory)!.size;
      const rawScore = totalUsersInAgency > 0 ? userCount / totalUsersInAgency : 0;
      const score = Math.max(0, Math.min(1, rawScore));
      cells.push({
        platformKey,
        roleCategory,
        userCount,
        concentrationScore: score,
        formula: `${userCount} / ${totalUsersInAgency} = ${(score * 100).toFixed(1)}%`,
      });
    }
  }

  return cells;
}
