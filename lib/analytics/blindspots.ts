/**
 * Access-analytics blindspots (#59).
 *
 * A "blindspot" is a user whose composite risk score exceeds `threshold`
 * AND whose most recent `identity.certification_campaign.*` audit event
 * is older than `staleCertificationDays` (or absent entirely).
 *
 * The risk math is NOT reinvented here — the input `UserRisk[]` is
 * supplied by the caller (in the web app: `computeUserRiskScores`).
 * Inventing new weights here would drift from the Permission Analysis
 * page.
 *
 * Pure function. The list is CAPPED at `maxResults` (default 50) sorted
 * by risk score descending.
 */

/**
 * Structural shape of a per-user risk row. Callers may pass a richer
 * object; only these fields are consulted here.
 */
export interface UserRiskInput {
  userId: string;
  email: string;
  name: string;
  riskScore: number;
  factors?: Array<{ type: string; score: number }>;
}

export interface CertificationEvent {
  /** The user the certification event references. */
  userId: string;
  /** ISO timestamp of the most-recent certification event for that user. */
  lastCertifiedAt: string;
}

export type BlindspotReason =
  | 'stale_admin'
  | 'concentration_outlier'
  | 'unverified_access'
  | 'missing_expiration'
  | 'uncertified_high_risk';

export interface Blindspot {
  userId: string;
  email: string;
  name: string;
  riskScore: number;
  reason: BlindspotReason;
  /**
   * Days since the most recent `identity.certification_campaign.*` event
   * for this user. `null` = never certified (or no event in the window).
   */
  daysSinceCertification: number | null;
  /** Pass-through of the top factor slugs from the risk scorer. */
  factors: string[];
}

export interface BuildBlindspotsArgs {
  userRisks: UserRiskInput[];
  certifications: CertificationEvent[];
  threshold?: number;
  staleCertificationDays?: number;
  maxResults?: number;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

const DEFAULT_THRESHOLD = 60;
const DEFAULT_STALE_DAYS = 30;
const DEFAULT_MAX = 50;

function reasonFromFactors(factors: { type: string; score: number }[]): BlindspotReason {
  if (!factors || factors.length === 0) return 'uncertified_high_risk';
  const top = [...factors].sort((a, b) => b.score - a.score)[0];
  const t = top.type;
  if (t.includes('admin') || t.includes('elevated')) return 'stale_admin';
  if (t.includes('platform') || t.includes('client') || t.includes('scope')) return 'concentration_outlier';
  if (t.includes('verif') || t.includes('stale')) return 'unverified_access';
  if (t.includes('expir') || t.includes('permanent')) return 'missing_expiration';
  return 'uncertified_high_risk';
}

export function buildBlindspots(args: BuildBlindspotsArgs): Blindspot[] {
  const {
    userRisks,
    certifications,
    threshold = DEFAULT_THRESHOLD,
    staleCertificationDays = DEFAULT_STALE_DAYS,
    maxResults = DEFAULT_MAX,
    now = new Date(),
  } = args;

  const nowMs = now.getTime();
  const staleCutoff = nowMs - staleCertificationDays * 24 * 60 * 60 * 1000;

  const certByUser = new Map<string, number>();
  for (const c of certifications) {
    const t = new Date(c.lastCertifiedAt).getTime();
    if (isNaN(t)) continue;
    const existing = certByUser.get(c.userId);
    if (existing === undefined || t > existing) certByUser.set(c.userId, t);
  }

  const blindspots: Blindspot[] = [];
  for (const user of userRisks) {
    if (user.riskScore < threshold) continue;

    const lastCertMs = certByUser.get(user.userId);
    const isStale = lastCertMs === undefined || lastCertMs < staleCutoff;
    if (!isStale) continue;

    const daysSinceCertification = lastCertMs === undefined
      ? null
      : Math.floor((nowMs - lastCertMs) / (24 * 60 * 60 * 1000));

    blindspots.push({
      userId: user.userId,
      email: user.email,
      name: user.name,
      riskScore: user.riskScore,
      reason: reasonFromFactors(user.factors ?? []),
      daysSinceCertification,
      factors: (user.factors ?? []).map((f) => f.type),
    });
  }

  blindspots.sort((a, b) => b.riskScore - a.riskScore || a.userId.localeCompare(b.userId));

  return blindspots.slice(0, maxResults);
}
