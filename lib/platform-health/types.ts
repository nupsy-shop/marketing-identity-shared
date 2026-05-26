/**
 * Platform Health — shared types.
 *
 * Canonical connection-state values for the health checker and UI.
 * `degraded` is new (issue #54) and indicates "the last sync succeeded
 * but the sync is stale or partial" or "active check succeeded with
 * partial service."
 */

export type ConnectionState =
  | 'connected'
  | 'degraded'
  | 'error'
  | 'needs_reauth'
  | 'disconnected';

export const CONNECTION_STATES: ConnectionState[] = [
  'connected',
  'degraded',
  'error',
  'needs_reauth',
  'disconnected',
];

export interface HealthCheckInput {
  /** The identity source row (read-only). */
  source: {
    id: string;
    agencyId: string;
    pluginKey: string;
    connectionState: string | null;
    lastSyncAt: Date | null;
    lastSyncStatus: string | null;
    lastSyncError: string | null;
    syncIntervalHours: number | null;
  };
  /** Current time; injectable for tests. */
  now?: Date;
  /** Optional provider liveness result (injected by orchestrator). */
  liveness?: LivenessResult;
}

export interface LivenessResult {
  ok: boolean;
  latencyMs: number;
  /**
   * Categorized error:
   *  - `auth`     → checker flips to `needs_reauth`
   *  - `network`/`server`/`unknown` → checker flips to `error`
   *  - `flap`     → checker flips to `degraded`. Used by the orchestrator
   *                 when the synthetic probe succeeded but the
   *                 provider-auth failure counter is above threshold
   *                 (see PROVIDER_AUTH_FAILURE_THRESHOLD).
   */
  errorCategory?: 'auth' | 'network' | 'server' | 'unknown' | 'flap';
  errorMessage?: string;
}

export interface HealthCheckOutcome {
  newState: ConnectionState;
  previousState: string | null;
  transitioned: boolean;
  latencyMs: number;
  errorCategory?: string;
  reason: string;
}

/** Default expected sync interval per plugin when the DB column is null. */
export const DEFAULT_SYNC_INTERVAL_HOURS = 6;

/** Multiplier that defines "stale" — > interval * STALE_MULTIPLIER → degraded. */
export const STALE_MULTIPLIER = 2;

/** Debounce window for state-change notifications (ms). */
export const DEBOUNCE_WINDOW_MS = 5 * 60 * 1000;

/** Uptime computation window (days). */
export const UPTIME_WINDOW_DAYS = 30;

/**
 * Provider-auth failure counter window (seconds). The user-call boundary
 * (`getValidAccessToken` and equivalents) increments a Redis-backed counter
 * when a per-request token refresh fails; the next probe tick reads it over
 * this window. Aligned with the host's record TTL.
 */
export const PROVIDER_AUTH_FAILURE_WINDOW_SECONDS = 15 * 60;

/**
 * Threshold above which an otherwise-OK synthetic probe is downgraded to
 * `degraded`. Three failures in a 15-min window is enough signal that
 * something flaky is happening at the provider's end, while leaving room
 * for one-off transients to be absorbed silently.
 */
export const PROVIDER_AUTH_FAILURE_THRESHOLD = 3;
