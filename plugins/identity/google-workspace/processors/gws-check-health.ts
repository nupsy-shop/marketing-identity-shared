/**
 * GWS Connection Health Check — Plugin Processor
 *
 * Processes `gws_check_health` Bull jobs. For the agency in the job
 * payload, runs the GWS liveness probe (real refresh-token round-trip
 * via the host-registered `resolveGwsAccessToken`) against every
 * `identity_sources` row with `plugin_key = 'google-workspace'`,
 * evaluates against the Platform Health enum, and persists the
 * resulting `connection_state` (transitions audited and notified
 * through the orchestrator's standard path).
 *
 * Enqueued by `dispatch_check_connector_health` (cron `*\/10 * * * *`),
 * which fans out one job per (agency × plugin) tuple. See #988.
 *
 * Plugin-owned: the dispatcher that creates these jobs lives in the
 * Bull worker; the per-source iteration + state-transition logic lives
 * here so a future GWS-specific tuning (cadence, retries, concurrency)
 * stays inside the plugin folder.
 */

import type Bull from 'bull';
import { runHealthChecksForAgencyByPlugin } from '../../../../lib/platform-health/orchestrator.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { checkGoogleWorkspace } from '../liveness.js';

interface JobResult {
  status: 'completed';
  jobType: 'gws_check_health';
  agencyId: string;
  checked: number;
  transitioned: number;
  notified: number;
}

export default async function gwsCheckHealth(job: Bull.Job): Promise<JobResult> {
  const { tenantId, dryRun } = job.data as { tenantId: string; dryRun?: boolean };
  const { logger } = getRuntime();

  const results = await runHealthChecksForAgencyByPlugin({
    agencyId: tenantId,
    pluginKey: 'google-workspace',
    livenessFn: checkGoogleWorkspace,
    dryRun: Boolean(dryRun),
  });

  const transitioned = results.filter((r) => r.transitioned);
  if (transitioned.length > 0) {
    logger.info('gws_check_health: transitions', {
      jobId: String(job.id),
      tenantId,
      transitions: transitioned.map(
        (r) => `${r.sourceId}:${r.previousState}→${r.newState}`,
      ),
    });
  }

  return {
    status: 'completed',
    jobType: 'gws_check_health',
    agencyId: tenantId,
    checked: results.length,
    transitioned: transitioned.length,
    notified: results.filter((r) => r.notified).length,
  };
}
