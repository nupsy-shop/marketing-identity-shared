/**
 * Platform Health — orchestrator (shared, per-agency).
 *
 * Coordinates: evaluate → persist → audit → notify.
 * Called by the Heroku Scheduler script (web) and by the per-agency
 * bull worker (`check-connector-health-for-agency`).
 *
 * Invariants:
 *   - Every read/write filters on `agencyId` (caller supplies).
 *   - Read-only to credentials — liveness fetches use provider-public
 *     endpoints. Never rotates tokens, never mutates connection_config
 *     beyond the `lastHealthCheckAt` marker.
 *   - Audit payloads never carry secrets.
 *   - Prisma only; no raw SQL.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import { evaluateHealth } from './checker.js';
import { runLivenessCheck } from './liveness.js';
import { decideNotify } from './debounce.js';
import { fetchRecentTransitions } from './es-query.js';
import { DEBOUNCE_WINDOW_MS } from './types.js';
import type { HealthCheckOutcome } from './types.js';

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

export async function runHealthChecksForAgency(
  opts: RunForAgencyOptions,
): Promise<CheckedSource[]> {
  const { prisma, logger } = getRuntime();
  const { agencyId, dryRun = false } = opts;
  const now = opts.now ?? new Date();

  const sources = await prisma.identity_sources.findMany({
    where: { agency_id: agencyId },
    orderBy: { created_at: 'asc' },
  });

  const results: CheckedSource[] = [];

  for (const row of sources as Array<{
    id: string;
    plugin_key: string;
    display_name: string;
    connection_state: string | null;
    connection_config: unknown;
    last_sync_at: Date | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
    sync_interval_hours: number | null;
  }>) {
    try {
      const liveness = await runLivenessCheck({
        id: row.id,
        agencyId,
        pluginKey: row.plugin_key,
        connectionState: row.connection_state,
        connectionConfig: row.connection_config as Record<string, unknown> | null,
      });

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
        // Low-severity health_check trace — not notified, kept for
        // debugging the checker itself.
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

      results.push({
        sourceId: row.id,
        pluginKey: row.plugin_key,
        previousState: outcome.previousState,
        newState: outcome.newState,
        transitioned: outcome.transitioned,
        latencyMs: outcome.latencyMs,
        notified,
        reason: outcome.reason,
      });
    } catch (err: unknown) {
      logger.error('platform-health: source check failed', {
        agencyId,
        sourceId: row.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

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
