/**
 * Risk Scoring Engine
 *
 * Computes risk scores for agency members based on their actual access footprint.
 *
 * Access is determined by client team membership, NOT by who submitted access requests:
 *   - client_role_assignments  (direct role on a client)
 *   - client_owner_assignments (KAM or security_owner)
 *   - derived_role_assignments (IdP-derived, scope='client')
 *   - agency_admin / agency_owner (implicit access to all clients)
 *
 * Score: 0-100 (0 = no risk, 100 = critical)
 *
 * Factors:
 * - Client scope: +2 per client beyond 3 (max 15) — blast radius
 * - Platform exposure: +3 per platform beyond 3 (max 15) — breadth of access
 * - Admin/elevated roles: +10 per client admin role (max 20)
 * - Access age: +1 per 30 days since oldest grant (max 20)
 * - Inactivity: +5 per 30 days without activity (max 25)
 * - Missing verification: +5 per unverified item on their clients (max 15)
 * - Drift detected: +15 per drift event
 * - No expiration: +5 per permanent access item on their clients (max 15)
 */

import { getRuntime } from '../runtime.js';
import { queryAuditEvents } from '../audit/query.js';
import type { UserRisk, RiskFactor } from './recommendations.js';
import { RISK_EXCLUDED_ROLES, isExcludedFromRiskAnalysis } from './compliance-frameworks.js';

// --- Types -------------------------------------------------------------------

interface SodPolicy {
  conflictingRoles?: string[];
  [key: string]: unknown;
}

export interface RiskSummary {
  overallScore: number;
  overProvisionedCount: number;
  staleAccessCount: number;
  sodViolations: number;
  riskDistribution: {
    low: number;
    medium: number;
    high: number;
  };
  userCount: number;
  /**
   * Number of users (e.g. agency_owner) that were excluded from the analysis
   * because they hold full-access roles by design. Surfaced so the UI can
   * render the exclusion note and so audit logs can trace the reduction.
   */
  excludedOwnerCount: number;
}

// --- Constants ---------------------------------------------------------------

const ADMIN_ROLES = ['admin', 'owner', 'super_admin', 'administrator', 'manager'];

// --- Helpers -----------------------------------------------------------------

function daysSince(date: Date | string | null | undefined): number {
  if (!date) return Infinity;
  return Math.floor((Date.now() - new Date(date).getTime()) / (24 * 60 * 60 * 1000));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// --- User Risk Score Computation ---------------------------------------------

/**
 * Compute risk scores for all agency members based on their actual client
 * team membership and the access items on those clients.
 */
export async function computeUserRiskScores(agencyId: string): Promise<UserRisk[]> {
  // 1. Get all active users for this agency, excluding full-access roles
  //    (e.g. agency_owner). Filtering at the data layer keeps owners out of
  //    scoring, recommendations, and exports without UI-level guards.
  //    Per-client Security Owner / KAM are *not* excluded — only role-level
  //    owners are.
  const userRows = (await getRuntime().prisma.users.findMany({
    where: {
      agency_id: agencyId,
      is_active: true,
      NOT: { role: { in: [...RISK_EXCLUDED_ROLES] } },
    },
    select: { id: true, role: true, email: true, name: true },
  })) as Array<{ id: string; role: string; email: string | null; name: string | null }>;

  if (userRows.length === 0) return [];

  const members = userRows
    // Defensive: the Prisma filter already excludes owners, but re-apply so
    // any future code path that passes a pre-fetched list is safe.
    .filter(u => !isExcludedFromRiskAnalysis(u.role))
    .map(u => ({
      user_id: u.id,
      role: u.role,
      email: u.email,
      name: u.name,
    }));

  // 2. Get client team memberships from all sources (Prisma queries, no raw SQL)
  const [roleAssignments, ownerAssignments, derivedAssignments] = await Promise.all([
    getRuntime().prisma.client_role_assignments.findMany({
      where: { agency_id: agencyId, is_active: true },
      select: { app_user_id: true, client_id: true, role: true },
    }),
    getRuntime().prisma.client_owner_assignments.findMany({
      where: { agency_id: agencyId, is_active: true, app_user_id: { not: null } },
      select: { app_user_id: true, client_id: true, owner_type: true },
    }),
    getRuntime().prisma.derived_role_assignments.findMany({
      where: { agency_id: agencyId, is_active: true, scope: 'client', scope_client_id: { not: null } },
      select: { app_user_id: true, scope_client_id: true, role: true },
    }),
  ]);

  // Build user -> set of client IDs and roles
  const userClients = new Map<string, Set<string>>();
  const userClientRoles = new Map<string, string[]>();

  function addTeamEntry(userId: string, clientId: string, role: string) {
    if (!userClients.has(userId)) userClients.set(userId, new Set());
    userClients.get(userId)!.add(clientId);
    if (!userClientRoles.has(userId)) userClientRoles.set(userId, []);
    userClientRoles.get(userId)!.push(role);
  }

  for (const r of roleAssignments) addTeamEntry(r.app_user_id, r.client_id, r.role);
  for (const o of ownerAssignments) {
    if (o.app_user_id) addTeamEntry(o.app_user_id, o.client_id, o.owner_type);
  }
  for (const d of derivedAssignments) {
    if (d.scope_client_id) addTeamEntry(d.app_user_id, d.scope_client_id, d.role);
  }

  // Note: agency_owner / agency_admin have implicit *administrative* access to
  // all clients, but that is management scope — not personal access risk.
  // Risk scoring only considers explicit client team assignments
  // (role assignments, ownership, derived roles).

  interface AccessItem {
    id: string;
    role: string | null;
    status: string;
    createdAt: Date | null;
    verification_status: string | null;
    expiresAt: Date | null;
    access_requests: { clientId: string };
    catalog_platforms: { slug: string } | null;
  }

  // 3. Get completed access request items (only completed = actual effective access)
  const accessItems = (await getRuntime().prisma.access_request_items.findMany({
    where: { agency_id: agencyId, status: 'completed' },
    select: {
      id: true,
      role: true,
      status: true,
      createdAt: true,
      verification_status: true,
      expiresAt: true,
      access_requests: { select: { clientId: true } },
      catalog_platforms: { select: { slug: true } },
    },
  })) as AccessItem[];

  // Build client -> items map
  const itemsByClient = new Map<string, AccessItem[]>();
  for (const item of accessItems) {
    const clientId = item.access_requests.clientId;
    if (!itemsByClient.has(clientId)) itemsByClient.set(clientId, []);
    itemsByClient.get(clientId)!.push(item);
  }

  // 4. Get last activity from audit events
  const userLastActivity = new Map<string, string>();
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const activityResult = await queryAuditEvents({
      agency_id: agencyId,
      from: ninetyDaysAgo,
      size: 200,
      sort: 'desc',
    });
    for (const event of activityResult.data) {
      const email = event.actor?.email;
      if (email && !userLastActivity.has(email)) {
        userLastActivity.set(email, event.timestamp);
      }
    }
  } catch {
    // ES may be unavailable — continue without activity data
  }

  // 5. Get drift events
  const driftCountByUser = new Map<string, number>();
  try {
    const driftResult = await queryAuditEvents({
      agency_id: agencyId,
      type: 'platform.*.drift.detected',
      size: 200,
    });
    for (const event of driftResult.data) {
      const email = event.actor?.email || (event.context?.userEmail as string | undefined);
      if (email) {
        driftCountByUser.set(email, (driftCountByUser.get(email) || 0) + 1);
      }
    }
  } catch {
    // Continue without drift data
  }

  // 6. Compute scores for each member
  const results: UserRisk[] = [];
  for (const member of members) {
    const factors: RiskFactor[] = [];
    let score = 0;

    const memberClientIds = userClients.get(member.user_id) || new Set<string>();

    // Collect all completed access items across the member's clients
    const memberItems: typeof accessItems = [];
    const platforms = new Set<string>();
    for (const clientId of memberClientIds) {
      const clientItems = itemsByClient.get(clientId) || [];
      memberItems.push(...clientItems);
      for (const item of clientItems) {
        if (item.catalog_platforms?.slug) platforms.add(item.catalog_platforms.slug);
      }
    }

    // Factor: Client scope (+2 per client beyond 3, max 15)
    if (memberClientIds.size > 3) {
      const scopeScore = clamp((memberClientIds.size - 3) * 2, 0, 15);
      score += scopeScore;
      factors.push({ type: 'client_scope', score: scopeScore, detail: `Access to ${memberClientIds.size} clients` });
    }

    // Factor: Platform exposure (+3 per platform beyond 3, max 15)
    if (platforms.size > 3) {
      const platformScore = clamp((platforms.size - 3) * 3, 0, 15);
      score += platformScore;
      factors.push({ type: 'platform_count', score: platformScore, detail: `Exposure to ${platforms.size} platforms` });
    }

    // Factor: Admin/elevated roles on clients (+10 per admin role, max 20)
    const memberRoles = userClientRoles.get(member.user_id) || [];
    let adminCount = 0;
    for (const role of memberRoles) {
      const r = role.toLowerCase();
      if (ADMIN_ROLES.some(ar => r === ar || r.endsWith('_' + ar))) adminCount++;
    }
    // Also check platform-level admin roles from access items
    for (const item of memberItems) {
      const role = item.role?.toLowerCase() || '';
      if (ADMIN_ROLES.some(r => role === r || role.endsWith('_' + r))) adminCount++;
    }
    if (adminCount > 0) {
      const adminScore = clamp(adminCount * 10, 0, 20);
      score += adminScore;
      factors.push({ type: 'admin_roles', score: adminScore, detail: `${adminCount} admin/elevated role(s)` });
    }

    // Factor: Access age (+1 per 30 days since oldest grant, max 20)
    let maxAgeDays = 0;
    for (const item of memberItems) {
      const age = daysSince(item.createdAt);
      if (age !== Infinity && age > maxAgeDays) maxAgeDays = age;
    }
    if (maxAgeDays > 0) {
      const ageScore = clamp(Math.floor(maxAgeDays / 30), 0, 20);
      if (ageScore > 0) {
        score += ageScore;
        factors.push({ type: 'access_age', score: ageScore, detail: `Oldest access: ${maxAgeDays} days` });
      }
    }

    // Factor: Inactivity (+5 per 30 days, max 25)
    const lastActivity = userLastActivity.get(member.email || '');
    const hasAccess = memberClientIds.size > 0;
    const inactiveDays = lastActivity ? daysSince(lastActivity) : (hasAccess ? 90 : 0);
    if (inactiveDays > 30) {
      const inactivityScore = clamp(Math.floor(inactiveDays / 30) * 5, 0, 25);
      score += inactivityScore;
      factors.push({ type: 'inactivity', score: inactivityScore, detail: `No activity in ${inactiveDays} days` });
    }

    // Factor: Missing verification (+5 per unverified item, max 15)
    const unverifiedCount = memberItems.filter(i =>
      !i.verification_status || i.verification_status === 'pending'
    ).length;
    if (unverifiedCount > 0) {
      const verifyScore = clamp(unverifiedCount * 5, 0, 15);
      score += verifyScore;
      factors.push({ type: 'missing_verification', score: verifyScore, detail: `${unverifiedCount} unverified item(s)` });
    }

    // Factor: Drift detected (+15 per drift event)
    const driftCount = driftCountByUser.get(member.email || '') || 0;
    if (driftCount > 0) {
      const driftScore = driftCount * 15;
      score += driftScore;
      factors.push({ type: 'drift_detected', score: driftScore, detail: `${driftCount} drift event(s)` });
    }

    // Factor: No expiration (+5 per permanent item, max 15)
    const permanentCount = memberItems.filter(i => !i.expiresAt).length;
    if (permanentCount > 0) {
      const permScore = clamp(permanentCount * 5, 0, 15);
      score += permScore;
      factors.push({ type: 'no_expiration', score: permScore, detail: `${permanentCount} permanent access item(s)` });
    }

    results.push({
      userId: member.user_id,
      email: member.email || '',
      name: member.name || member.email || '',
      riskScore: clamp(score, 0, 100),
      factors,
      platforms: [...platforms],
      lastActivity: lastActivity || null,
      role: member.role,
    });
  }

  // Sort by risk score descending
  results.sort((a, b) => b.riskScore - a.riskScore);
  return results;
}

/**
 * Count active users that are excluded from risk analysis because they hold
 * full-access roles (e.g. agency_owner). Surfaced in the summary so the UI
 * can render the exclusion note and audit logs can trace the reduction.
 */
export async function countExcludedOwners(agencyId: string): Promise<number> {
  return getRuntime().prisma.users.count({
    where: {
      agency_id: agencyId,
      is_active: true,
      role: { in: [...RISK_EXCLUDED_ROLES] },
    },
  });
}

/**
 * Compute aggregate risk summary for the agency.
 */
export async function computeRiskSummary(agencyId: string): Promise<RiskSummary> {
  const [userRisks, excludedOwnerCount] = await Promise.all([
    computeUserRiskScores(agencyId),
    countExcludedOwners(agencyId),
  ]);

  const overallScore = userRisks.length > 0
    ? Math.round(userRisks.reduce((sum, u) => sum + u.riskScore, 0) / userRisks.length)
    : 0;

  // Over-provisioned = excess platform access OR admin roles combined with platform access.
  const overProvisionedCount = userRisks.filter(u => {
    const hasPlatformCount = u.factors.some(f => f.type === 'platform_count');
    const hasAdminRoles = u.factors.some(f => f.type === 'admin_roles');
    return hasPlatformCount || (hasAdminRoles && u.platforms.length > 0);
  }).length;

  const staleAccessCount = userRisks.filter(u =>
    u.factors.some(f => f.type === 'inactivity' && f.score >= 10)
  ).length;

  // SoD violations need to be checked separately
  const sodViolations = await countSodViolations(agencyId, userRisks);

  // Risk distribution
  const riskDistribution = {
    low: userRisks.filter(u => u.riskScore < 30).length,
    medium: userRisks.filter(u => u.riskScore >= 30 && u.riskScore < 70).length,
    high: userRisks.filter(u => u.riskScore >= 70).length,
  };

  return {
    overallScore,
    overProvisionedCount,
    staleAccessCount,
    sodViolations,
    riskDistribution,
    userCount: userRisks.length,
    excludedOwnerCount,
  };
}

/**
 * Count SoD violations based on configured policies.
 */
async function countSodViolations(agencyId: string, userRisks: UserRisk[]): Promise<number> {
  try {
    const settingsRow = await getRuntime().prisma.agency_settings.findFirst({
      where: { agency_id: agencyId },
      select: { sod_policies: true },
    });
    const policies = (settingsRow?.sod_policies ?? []) as SodPolicy[];
    if (!Array.isArray(policies) || policies.length === 0) return 0;

    let violations = 0;
    for (const user of userRisks) {
      for (const policy of policies) {
        const conflicting = policy.conflictingRoles || [];
        const hasConflict = conflicting.every(role =>
          user.factors.some(f => f.detail?.toLowerCase().includes(role))
        );
        if (hasConflict) violations++;
      }
    }
    return violations;
  } catch {
    return 0;
  }
}
