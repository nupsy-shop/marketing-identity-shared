/**
 * Platform Health — pure state-machine evaluator.
 *
 * Given a source row + (optional) liveness result + now(), return the
 * new connection state. The helper is side-effect-free so it is
 * unit-testable; the orchestrator handles DB writes, audit emit, and
 * notification dispatch.
 *
 * Rules:
 *   - If the active liveness check failed with `auth` → `needs_reauth`.
 *   - If liveness failed otherwise → `error`.
 *   - If liveness succeeded and last_sync_at is older than
 *     expected_sync_interval × 2 → `degraded` (silent staleness).
 *   - If liveness succeeded and last sync was recent/success → `connected`.
 *   - If last_sync_status = 'failed' and no liveness result → mirror
 *     the last sync outcome.
 *
 * Never mutates the input. Never calls a provider. The orchestrator
 * supplies liveness; this helper just maps facts → state.
 */

import type {
  HealthCheckInput,
  HealthCheckOutcome,
  ConnectionState,
} from './types.js';
import {
  DEFAULT_SYNC_INTERVAL_HOURS,
  STALE_MULTIPLIER,
} from './types.js';

export function evaluateHealth(input: HealthCheckInput): HealthCheckOutcome {
  const now = input.now ?? new Date();
  const { source, liveness } = input;
  const previousState = source.connectionState;
  const intervalHours = source.syncIntervalHours ?? DEFAULT_SYNC_INTERVAL_HOURS;
  const staleThresholdMs = intervalHours * STALE_MULTIPLIER * 60 * 60 * 1000;

  const lastSyncAge = source.lastSyncAt
    ? now.getTime() - source.lastSyncAt.getTime()
    : Infinity;
  const isStale = lastSyncAge > staleThresholdMs;

  let newState: ConnectionState;
  let reason: string;

  if (liveness && !liveness.ok) {
    if (liveness.errorCategory === 'auth') {
      newState = 'needs_reauth';
      reason = `Liveness auth failure: ${liveness.errorMessage || 'unauthenticated'}`;
    } else {
      newState = 'error';
      reason = `Liveness failure (${liveness.errorCategory || 'unknown'}): ${liveness.errorMessage || 'unknown error'}`;
    }
  } else if (liveness && liveness.ok) {
    if (isStale) {
      newState = 'degraded';
      reason = `Liveness OK but last sync is stale (age ${Math.round(lastSyncAge / 60000)}m > threshold ${intervalHours * STALE_MULTIPLIER}h)`;
    } else if (source.lastSyncStatus === 'failed') {
      newState = 'degraded';
      reason = `Liveness OK but last sync reported failed: ${source.lastSyncError || 'unknown'}`;
    } else {
      newState = 'connected';
      reason = 'Liveness OK and recent sync succeeded';
    }
  } else {
    if (previousState === 'disconnected') {
      newState = 'disconnected';
      reason = 'Source is disconnected; no check performed';
    } else if (isStale) {
      newState = 'degraded';
      reason = `Last sync is stale (age ${isFinite(lastSyncAge) ? Math.round(lastSyncAge / 60000) + 'm' : 'never synced'} > threshold ${intervalHours * STALE_MULTIPLIER}h)`;
    } else if (source.lastSyncStatus === 'failed') {
      newState = 'error';
      reason = `Last sync failed: ${source.lastSyncError || 'unknown'}`;
    } else {
      newState = 'connected';
      reason = 'Last sync succeeded and is recent';
    }
  }

  return {
    newState,
    previousState,
    transitioned: previousState !== newState,
    latencyMs: liveness?.latencyMs ?? 0,
    errorCategory: liveness?.errorCategory,
    reason,
  };
}
