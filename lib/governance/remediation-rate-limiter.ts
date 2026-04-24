/**
 * Redis-backed per-agency rate limiter for the auto-remediation engine.
 *
 * Closes Known gap #2: the previous in-memory `_rateLimitCounters` map was
 * process-local, so the effective cap on an N-dyno deployment was N × the
 * configured value. This limiter uses a Redis INCR keyed by
 * `autoremediation:ratelimit:<agency_id>:<yyyy-mm-dd-HH>` with a 1-hour TTL,
 * so the cap is honoured across every app dyno and the Bull worker.
 *
 * Gracefully degrades when Redis is unreachable: counts through an in-memory
 * fallback so local dev and a Redis outage don't block execution. On a real
 * outage the effective cap reverts to the per-process behaviour, which is
 * strictly safer than unbounded execution.
 */

import type { Redis as RedisType } from 'ioredis';
import { getRuntime } from '../runtime.js';

let Redis: typeof import('ioredis').default | null = null;
let client: RedisType | null = null;
let connectionAttempted = false;

function getRedisUrl(): string | null {
  return process.env.VALKEY_URL || process.env.REDIS_URL || process.env.BULL_REDIS_URL || null;
}

async function getClient(): Promise<RedisType | null> {
  if (client) return client;
  if (connectionAttempted) return null;

  const url = getRedisUrl();
  if (!url) {
    connectionAttempted = true;
    return null;
  }

  try {
    if (!Redis) {
      Redis = (await import('ioredis')).default;
    }
    client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      lazyConnect: true,
      retryStrategy(times: number): number | null {
        if (times > 3) return null;
        return Math.min(times * 200, 1000);
      },
      tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
    });
    client.on('error', (err: Error) => {
      getRuntime().logger.warn('[RemediationRateLimiter] Redis error (non-fatal):', { message: err.message });
    });
    await client.connect();
    connectionAttempted = true;
    return client;
  } catch (err) {
    getRuntime().logger.warn(
      '[RemediationRateLimiter] Failed to connect (operating in-process):',
      { message: err instanceof Error ? err.message : String(err) },
    );
    client = null;
    connectionAttempted = true;
    return null;
  }
}

// ─── In-memory fallback ──────────────────────────────────────────────────────

const fallback = new Map<string, number>();

function hourBucket(d: Date = new Date()): string {
  return d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

function rateLimitKey(agencyId: string, bucket: string): string {
  return `autoremediation:ratelimit:${agencyId}:${bucket}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return the current action count for an agency in the current hour bucket.
 */
export async function getActionCount(agencyId: string): Promise<number> {
  const bucket = hourBucket();
  const key = rateLimitKey(agencyId, bucket);

  const redis = await getClient();
  if (redis) {
    try {
      const val = await redis.get(key);
      return val ? parseInt(val, 10) || 0 : 0;
    } catch {
      // fall through to in-memory
    }
  }
  return fallback.get(key) ?? 0;
}

/**
 * Return true when the agency has already hit `max` executed actions in the
 * current hour bucket.
 */
export async function isRateLimited(agencyId: string, max: number): Promise<boolean> {
  const count = await getActionCount(agencyId);
  return count >= max;
}

/**
 * Increment the agency's hour-bucket counter. Called after a successful or
 * scheduled execution. Dry-run and rate-limited / circuit-breaker findings
 * MUST NOT call this — per the business rule, dry-run does not count toward
 * `maxActionsPerHour` and rate-limited findings obviously can't consume a
 * slot they never got.
 */
export async function incrementActionCount(agencyId: string): Promise<void> {
  const bucket = hourBucket();
  const key = rateLimitKey(agencyId, bucket);

  const redis = await getClient();
  if (redis) {
    try {
      const newVal = await redis.incr(key);
      if (newVal === 1) {
        // Set TTL slightly longer than the hour window so the key is removed
        // even if the process dies right after the INCR.
        await redis.expire(key, 3700);
      }
      return;
    } catch (err) {
      getRuntime().logger.warn(
        '[RemediationRateLimiter] INCR failed, falling back to in-memory:',
        { message: err instanceof Error ? err.message : String(err) },
      );
    }
  }
  fallback.set(key, (fallback.get(key) ?? 0) + 1);
}

/**
 * Test-only: reset all counters. Not exported from the engine; call directly
 * from tests when setting up a fresh scenario.
 */
export async function _resetForTests(): Promise<void> {
  fallback.clear();
  const redis = await getClient();
  if (redis) {
    try {
      const keys = await redis.keys('autoremediation:ratelimit:*');
      if (keys.length > 0) await redis.del(...keys);
    } catch {
      // ignore — tests that care will skip Redis anyway
    }
  }
}
