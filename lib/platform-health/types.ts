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
  /** Categorized error: 'auth' | 'network' | 'server' | 'unknown'. */
  errorCategory?: 'auth' | 'network' | 'server' | 'unknown';
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
