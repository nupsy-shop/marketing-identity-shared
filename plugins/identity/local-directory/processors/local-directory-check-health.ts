/**
 * Local Directory Connection Health Check — Plugin Processor
 *
 * Mirror of `gws-check-health.ts` / `entra-check-health.ts`. Processes
 * `local_directory_check_health` Bull jobs: for the agency in the job
 * payload, runs the Local Directory liveness probe (Keycloak admin
 * reachability + per-agency realm existence) against every
 * `identity_sources` row with `plugin_key = 'local-directory'`,
 * persists state transitions through the shared orchestrator.
 *
 * Sync-signal stamp:
 *   Local Directory has no upstream "sync" — it is write-managed
 *   (DB writes mirror to Keycloak inline). Without an explicit
 *   `last_sync_at` update, `evaluateHealth` would trip the staleness
 *   branch (age > syncIntervalHours × 2) and force the source to
 *   `degraded` even when liveness is OK. After a successful liveness
 *   we therefore stamp `last_sync_at = now` and `last_sync_status =
 *   'success'`, treating the health probe itself as the canonical
 *   liveness pulse.
 *
 *   We gate the stamp on the orchestrator's `reason` field starting
 *   with "Liveness OK" rather than `newState === 'connected'`. The
 *   `connected` state is unreachable on the very first probe because
 *   evaluateHealth treats `last_sync_at = NULL` as Infinity-stale and
 *   returns `degraded` (chicken-and-egg). Gating on the liveness
 *   outcome instead lets the first successful probe seed the
 *   freshness; the next probe then sees a fresh stamp and lands in
 *   `connected`.
 *
 *   Failed checks deliberately do NOT touch `last_sync_*`; the
 *   orchestrator already moved the row into `error` / `needs_reauth`
 *   based on the liveness outcome, and we want the staleness clock to
 *   keep running so a long-broken source eventually surfaces in
 *   monitoring even if liveness somehow flaps.
 */

import type Bull from 'bull';
import { runHealthChecksForAgencyByPlugin } from '../../../../lib/platform-health/orchestrator.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { checkLocalDirectory } from '../liveness.js';

interface JobResult {
  status: 'completed';
  jobType: 'local_directory_check_health';
  agencyId: string;
  checked: number;
  transitioned: number;
  notified: number;
}

export default async function localDirectoryCheckHealth(
  job: Bull.Job,
): Promise<JobResult> {
  const { tenantId, dryRun } = job.data as { tenantId: string; dryRun?: boolean };
  const { logger, prisma } = getRuntime();

  const results = await runHealthChecksForAgencyByPlugin({
    agencyId: tenantId,
    pluginKey: 'local-directory',
    livenessFn: checkLocalDirectory,
    dryRun: Boolean(dryRun),
  });

  if (!dryRun) {
    const now = new Date();
    // Stamp on liveness success, NOT on newState === 'connected'.
    //
    // Why: evaluateHealth treats `last_sync_at = NULL` as Infinity-stale and
    // returns `degraded` even when the liveness probe just succeeded. If we
    // gated the stamp on `connected`, the first-ever probe could never reach
    // `connected` (because last_sync_at is NULL), so we'd never stamp, and
    // the row would be stuck in `degraded` forever — exactly the loop we
    // saw in production for agency-trevox's local-directory row.
    //
    // The orchestrator's `reason` string starts with "Liveness OK" iff the
    // probe was ok (see shared/lib/platform-health/checker.ts), which is the
    // signal we actually care about for the sync-signal stamp on this
    // write-managed source. After the stamp lands, the NEXT probe's
    // evaluateHealth sees a fresh last_sync_at and returns `connected`.
    const livenessOk = results.filter((r) => r.reason?.startsWith('Liveness OK'));
    for (const r of livenessOk) {
      try {
        await prisma.identity_sources.update({
          where: { id: r.sourceId },
          data: {
            last_sync_at: now,
            last_sync_status: 'success',
            last_sync_error: null,
          },
        });
      } catch (err: unknown) {
        logger.warn('local_directory_check_health: failed to stamp last_sync_at', {
          sourceId: r.sourceId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const transitioned = results.filter((r) => r.transitioned);
  if (transitioned.length > 0) {
    logger.info('local_directory_check_health: transitions', {
      jobId: String(job.id),
      tenantId,
      transitions: transitioned.map(
        (r) => `${r.sourceId}:${r.previousState}→${r.newState}`,
      ),
    });
  }

  return {
    status: 'completed',
    jobType: 'local_directory_check_health',
    agencyId: tenantId,
    checked: results.length,
    transitioned: transitioned.length,
    notified: results.filter((r) => r.notified).length,
  };
}
