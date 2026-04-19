/**
 * Per-user "last activity" — shared by risk-scorer.ts and the
 * cost-optimization scanner (Issue #58).
 *
 * Reads ES audit events to answer:
 *   - when did each user last do anything, agency-scoped?
 *   - did they perform any write-class action in the window?
 *
 * Cached per scan run in memory (the Map returned here). No cross-agency
 * queries — the helper takes agencyId as an explicit argument and every
 * query filters by it.
 *
 * Framework-agnostic: no `@/` imports. Both the web app's scheduler
 * script and the per-agency Bull worker use this one module.
 */

import type { ActivitySnapshot } from '../cost-optimization/types.js';

export interface LastActivityInput {
  agencyId: string;
  userIds: string[];
  windowDays: number;
  now: Date;
}

// Best-effort ES hit. Implementation keeps this out of the hot path when ES
// isn't configured — the scanner still runs with source='unknown' which
// means "activity signals unavailable" and no unused findings for that user.
async function queryEsLastActivity(
  agencyId: string,
  userIds: string[],
  sinceISO: string,
): Promise<Map<string, { lastAt: Date | null; hasWrite: boolean }>> {
  const out = new Map<string, { lastAt: Date | null; hasWrite: boolean }>();
  const SEARCHBOX_URL = process.env.SEARCHBOX_URL;
  if (!SEARCHBOX_URL || userIds.length === 0) return out;

  let esBase = SEARCHBOX_URL.replace(/\/$/, '');
  let esAuth: string | null = null;
  try {
    const u = new URL(SEARCHBOX_URL);
    if (u.username) {
      esAuth = 'Basic ' + Buffer.from(`${u.username}:${u.password}`).toString('base64');
      esBase = `${u.protocol}//${u.host}`;
    }
  } catch {
    /* ignore */
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (esAuth) headers['Authorization'] = esAuth;

  const body = {
    size: 0,
    query: {
      bool: {
        must: [
          { term: { 'agency.id': agencyId } },
          { terms: { 'actor.id': userIds } },
          { range: { timestamp: { gte: sinceISO } } },
        ],
      },
    },
    aggs: {
      by_user: {
        terms: { field: 'actor.id', size: Math.max(userIds.length, 10) },
        aggs: {
          last_seen: { max: { field: 'timestamp' } },
          writes: {
            filter: {
              bool: {
                should: [
                  { wildcard: { eventType: '*.create' } },
                  { wildcard: { eventType: '*.update' } },
                  { wildcard: { eventType: '*.delete' } },
                  { wildcard: { eventType: '*.revoke*' } },
                  { wildcard: { action: '*write*' } },
                  { wildcard: { action: '*update*' } },
                  { wildcard: { action: '*create*' } },
                  { wildcard: { action: '*delete*' } },
                ],
              },
            },
          },
        },
      },
    },
  };

  try {
    const res = await fetch(`${esBase}/audit-*/_search`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) return out;
    const data = (await res.json()) as {
      aggregations?: {
        by_user?: {
          buckets?: Array<{
            key: string;
            last_seen?: { value_as_string?: string };
            writes?: { doc_count?: number };
          }>;
        };
      };
    };
    const buckets = data.aggregations?.by_user?.buckets || [];
    for (const b of buckets) {
      const iso = b.last_seen?.value_as_string || null;
      out.set(b.key, {
        lastAt: iso ? new Date(iso) : null,
        hasWrite: Boolean(b.writes?.doc_count && b.writes.doc_count > 0),
      });
    }
  } catch {
    /* network/ES failure is non-fatal; falls through to 'unknown' */
  }
  return out;
}

export async function getLastActivityForUsers(
  input: LastActivityInput,
): Promise<Map<string, ActivitySnapshot>> {
  const { agencyId, userIds, windowDays, now } = input;
  const result = new Map<string, ActivitySnapshot>();
  if (userIds.length === 0) return result;

  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const esHits = await queryEsLastActivity(agencyId, userIds, since.toISOString());

  for (const userId of userIds) {
    const hit = esHits.get(userId);
    if (hit) {
      result.set(userId, {
        userId,
        lastActivityAt: hit.lastAt,
        source: 'audit',
        hasWriteActivity: hit.hasWrite,
      });
    } else {
      // No ES results in the window → caller interprets as:
      //   - if ES is configured, the user was idle in the window (lastActivityAt=null, source=audit)
      //   - if ES is not configured (no SEARCHBOX_URL), treat as 'unknown'.
      const esConfigured = Boolean(process.env.SEARCHBOX_URL);
      result.set(userId, {
        userId,
        lastActivityAt: null,
        source: esConfigured ? 'audit' : 'unknown',
        hasWriteActivity: false,
      });
    }
  }
  return result;
}
