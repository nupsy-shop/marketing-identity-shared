export type RoleTier = 'admin' | 'standard' | 'read';

export interface TierableRole {
  key: string;
  label?: string;
  tier?: RoleTier;
}

export const ROLE_TIER_TONE: Record<RoleTier, 'destructive' | 'brand' | 'secondary'> = {
  admin: 'destructive',
  standard: 'brand',
  read: 'secondary',
};

const ADMIN_PATTERNS = ['admin', 'owner', 'super', 'manage', 'sysadmin', 'accountadmin', 'system-administrator'];
const READ_PATTERNS = ['view', 'read', 'analyst', 'analyze', 'guest', 'reader', 'limited', 'email-only', 'audience'];

export function deriveRoleTier(role: TierableRole): RoleTier {
  if (role.tier) return role.tier;
  const haystack = `${role.key} ${role.label ?? ''}`.toLowerCase();
  const adminHit = ADMIN_PATTERNS.some((p) =>
    p === 'manage'
      ? /\bmanage\b/.test(haystack) || haystack.includes('manager (')
      : haystack.includes(p),
  );
  if (adminHit) return 'admin';
  if (READ_PATTERNS.some((p) => haystack.includes(p))) return 'read';
  return 'standard';
}
