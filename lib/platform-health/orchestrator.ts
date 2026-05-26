/**
 * Platform Health — orchestrator (per-source + per-plugin entry points).
 *
 * Coordinates: evaluate → persist → audit → notify, for one identity
 * source at a time. Two callable layers:
 *
 *   1. {@link runHealthChecksForAgencyByPlugin} — the canonical Bull
 *      entry point. Each per-plugin processor (gws-check-health,
 *      entra-check-health) calls this with its own `pluginKey` and
 *      `livenessFn`. Iterates the agency's identity_sources for that
 *      plugin, runs the supplied probe per source, and dispatches to
 *      {@link runHealthCheckForSource}.
 *
 *   2. {@link runHealthChecksForAgency} — convenience wrapper that
 *      loops over both supported plugins. Used by the CLI script
 *      (`scripts/check-connector-health.ts`) and the test harness so
 *      they can run the full sweep without going through Bull. Always
 *      calls per-plugin paths internally — there is no separate
 *      cross-plugin job in the catalog.
 *
 * Invariants:
 *   - Every read/write filters on `agencyId` (caller supplies; per-plugin
 *     processor sets it from its job payload's `tenantId`).
 *   - Read-only to credentials — liveness fetches use provider tokens
 *     resolved via the runtime locator. Never rotates tokens, never
 *     mutates `connection_config` beyond the `lastHealthCheckAt` marker.
 *   - Audit payloads never carry secrets.
 *   - Prisma only; no raw SQL.
 *
 * Architecture note (#988): the prior cross-plugin
 * `check_connector_health_for_agency` job was deleted in favor of
 * per-plugin jobs (`gws_check_health`, `entra_check_health`) so each
 * plugin's probe owns its own job rows, retries, and concurrency.
 * Plugin-specific liveness lives at
 * `shared/plugins/identity/<plugin>/liveness.ts`.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { evaluateHealth } from './checker.js';
import { decideNotify } from './debounce.js';
import { fetchRecentTransitions } from './es-query.js';
import { DEBOUNCE_WINDOW_MS } from './types.js';
import type { HealthCheckOutcome, LivenessResult } from './types.js';

interface SourceForLiveness {
  id: string;
  agencyId: string;
  pluginKey: string;
  connectionState: string | null;
  connectionConfig: Record<string, unknown> | null;
}

/**
 * Plugin-supplied liveness probe. Must be read-only and bounded
 * (10s recommended). Categorize failures via `errorCategory` so the
 * checker can produce the right state transition. See
 * shared/plugins/identity/google-workspace/liveness.ts for the
 * canonical example.
 */
export type LivenessFn = (source: SourceForLiveness) => Promise<LivenessResult | undefined>;

interface RunByPluginOptions {
  agencyId: string;
  pluginKey: string;
  livenessFn: LivenessFn;
  now?: Date;
  dryRun?: boolean;
}

interface RunForAgencyOptions {
  agencyId: string;
  now?: Date;
  dryRun?: boolean;
}

export interface CheckedSource {
  sourceId: string;
  pluginKey: string;
  previousState: string | null;
  newState: string;
  transitioned: boolean;
  latencyMs: number;
  notified: boolean;
  reason: string;
}

interface SourceRow {
  id: string;
  plugin_key: string;
  display_name: string;
  connection_state: string | null;
  connection_config: unknown;
  last_sync_at: Date | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  sync_interval_hours: number | null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Bull entry point. Each per-plugin processor calls this with its own
 * pluginKey + liveness probe. Iterates only the agency's sources of
 * that plugin — leaves other plugins untouched (they have their own
 * job).
 */
export async function runHealthChecksForAgencyByPlugin(
  opts: RunByPluginOptions,
): Promise<CheckedSource[]> {
  const { prisma, logger } = getRuntime();
  const { agencyId, pluginKey, livenessFn, dryRun = false } = opts;
  const now = opts.now ?? new Date();

  const sources = (await prisma.identity_sources.findMany({
    where: { agency_id: agencyId, plugin_key: pluginKey },
    orderBy: { created_at: 'asc' },
  })) as SourceRow[];

  const results: CheckedSource[] = [];

  for (const row of sources) {
    try {
      const liveness = await livenessFn({
        id: row.id,
        agencyId,
        pluginKey: row.plugin_key,
        connectionState: row.connection_state,
        connectionConfig: row.connection_config as Record<string, unknown> | null,
      });

      const checked = await runHealthCheckForSource({
        agencyId,
        row,
        liveness,
        now,
        dryRun,
      });
      results.push(checked);
    } catch (err: unknown) {
      logger.error('platform-health: source check failed', {
        agencyId,
        pluginKey,
        sourceId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

/**
 * Convenience wrapper for the CLI script + test harness. Loops over
 * every supported plugin and invokes its `runHealthChecksForAgencyByPlugin`
 * path. The Bull worker does NOT use this — it calls the per-plugin
 * entry point directly via the per-plugin processor.
 *
 * This is the one place in `lib/platform-health/` that imports from
 * `plugins/identity/...` (the cross-plugin "knows about all plugins"
 * convenience seam). The per-plugin processors do not transit this
 * function.
 */
export async function runHealthChecksForAgency(
  opts: RunForAgencyOptions,
): Promise<CheckedSource[]> {
  const { agencyId, dryRun = false, now } = opts;

  // Imported inside the function so the per-plugin Bull processors
  // (which only need their own plugin's liveness) don't drag in the
  // other plugin's module.
  const [{ checkGoogleWorkspace }, { checkEntra }] = await Promise.all([
    import('../../plugins/identity/google-workspace/liveness.js'),
    import('../../plugins/identity/entra-id/liveness.js'),
  ]);

  const gws = await runHealthChecksForAgencyByPlugin({
    agencyId,
    pluginKey: 'google-workspace',
    livenessFn: checkGoogleWorkspace,
    now,
    dryRun,
  });
  const entra = await runHealthChecksForAgencyByPlugin({
    agencyId,
    pluginKey: 'entra-id',
    livenessFn: checkEntra,
    now,
    dryRun,
  });
  // Local directory has no remote endpoint to probe — its health is a pure
  // function of sync freshness (last_sync_at / last_sync_status). An
  // undefined-returning liveness routes evaluateHealth through its
  // sync-signal-only branch (stale → degraded, recent success → connected),
  // so stale/recovered local sources still surface on the dashboard and emit
  // state_change events for uptime math.
  const localDirectory = await runHealthChecksForAgencyByPlugin({
    agencyId,
    pluginKey: 'local-directory',
    livenessFn: async () => undefined,
    now,
    dryRun,
  });

  return [...gws, ...entra, ...localDirectory];
}

// ─── Per-source path (private to this module) ───────────────────────────────

interface RunForSourceArgs {
  agencyId: string;
  row: SourceRow;
  liveness: LivenessResult | undefined;
  now: Date;
  dryRun: boolean;
}

/**
 * Single-source path: evaluate the supplied liveness against the source
 * row's last-sync signals, persist the resulting connection_state,
 * audit + (debounced) notify on transition.
 *
 * Plugin-agnostic — the caller supplies an already-computed
 * {@link LivenessResult} (or undefined to fall back to sync-signal-only
 * evaluation in {@link evaluateHealth}).
 */
async function runHealthCheckForSource(
  args: RunForSourceArgs,
): Promise<CheckedSource> {
  const { agencyId, row, liveness, now, dryRun } = args;
  const { prisma } = getRuntime();

  const outcome = evaluateHealth({
    source: {
      id: row.id,
      agencyId,
      pluginKey: row.plugin_key,
      connectionState: row.connection_state,
      lastSyncAt: row.last_sync_at,
      lastSyncStatus: row.last_sync_status,
      lastSyncError: row.last_sync_error,
      syncIntervalHours: row.sync_interval_hours,
    },
    now,
    liveness,
  });

  // Stamp last_health_check_at inside connection_config (no migration).
  const existingConfig =
    (row.connection_config as Record<string, unknown> | null) ?? {};
  const nextConfig = { ...existingConfig, lastHealthCheckAt: now.toISOString() };

  if (!dryRun) {
    await prisma.identity_sources.update({
      where: { id: row.id },
      data: {
        connection_state: outcome.newState,
        connection_config: nextConfig,
        updated_at: now,
      },
    });
  }

  let notified = false;
  if (outcome.transitioned) {
    notified = await emitTransition({
      agencyId,
      sourceId: row.id,
      pluginKey: row.plugin_key,
      displayName: row.display_name,
      outcome,
      now,
      dryRun,
    });
  } else if (!dryRun) {
    publishAuditEvent({
      eventType: 'identity.source.health_check',
      source: 'platform-health',
      severity: 'info',
      actor: { id: 'system', type: 'system' },
      agency: { id: agencyId },
      resource: { type: 'identity_source', id: row.id, name: row.display_name },
      context: {
        pluginKey: row.plugin_key,
        state: outcome.newState,
        latencyMs: outcome.latencyMs,
      },
    }).catch(() => { /* non-fatal */ });
  }

  return {
    sourceId: row.id,
    pluginKey: row.plugin_key,
    previousState: outcome.previousState,
    newState: outcome.newState,
    transitioned: outcome.transitioned,
    latencyMs: outcome.latencyMs,
    notified,
    reason: outcome.reason,
  };
}

// ─── Transition emit (private) ──────────────────────────────────────────────

interface EmitOpts {
  agencyId: string;
  sourceId: string;
  pluginKey: string;
  displayName: string;
  outcome: HealthCheckOutcome;
  now: Date;
  dryRun: boolean;
}

async function emitTransition(opts: EmitOpts): Promise<boolean> {
  const { agencyId, sourceId, pluginKey, displayName, outcome, now, dryRun } = opts;

  // Always emit the state_change event for uptime math — audit is the
  // source of truth. Debounce only gates the *notification*, not the audit.
  const payload = {
    pluginKey,
    sourceId,
    previousState: outcome.previousState,
    newState: outcome.newState,
    latencyMs: outcome.latencyMs,
    errorCategory: outcome.errorCategory,
    reason: outcome.reason,
    // Invariant: never include credentials / tokens / user lists.
  };

  if (!dryRun) {
    publishAuditEvent({
      eventType: 'identity.source.state_change',
      source: 'platform-health',
      severity: outcome.newState === 'connected' ? 'info' : 'warning',
      actor: { id: 'system', type: 'system' },
      agency: { id: agencyId },
      resource: { type: 'identity_source', id: sourceId, name: displayName },
      context: payload,
    }).catch(() => { /* non-fatal */ });
  }

  // Notification decision: check the audit log for prior emits landing
  // on the same newState within the debounce window.
  let recent: Awaited<ReturnType<typeof fetchRecentTransitions>> = [];
  try {
    recent = await fetchRecentTransitions(agencyId, sourceId, DEBOUNCE_WINDOW_MS, now);
  } catch {
    // If ES is down we fail-open — better to over-notify than to swallow a
    // real state change. The downstream dispatcher is still fire-and-forget.
  }

  const decision = decideNotify({
    now,
    newState: outcome.newState,
    previousState: outcome.previousState,
    recentTransitions: recent,
  });

  if (!decision.shouldNotify || dryRun) return false;

  const eventType = notificationEventFor(outcome);
  if (!eventType) return false;

  await dispatchNotification(agencyId, eventType, {
    source: displayName,
    pluginKey,
    sourceId,
    previousState: outcome.previousState,
    newState: outcome.newState,
    latencyMs: outcome.latencyMs,
    errorCategory: outcome.errorCategory,
  }).catch(() => { /* non-fatal */ });

  return true;
}

function notificationEventFor(outcome: HealthCheckOutcome): string | null {
  if (outcome.newState === 'degraded') return 'identity.source.degraded';
  if (
    outcome.newState === 'connected' &&
    (outcome.previousState === 'degraded' ||
      outcome.previousState === 'error' ||
      outcome.previousState === 'needs_reauth')
  ) {
    return 'identity.source.restored';
  }
  if (outcome.newState === 'error') return 'identity.source.degraded';
  if (outcome.newState === 'needs_reauth') return 'identity.source.degraded';
  return null;
}
