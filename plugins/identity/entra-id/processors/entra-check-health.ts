/**
 * Entra ID Connection Health Check — Plugin Processor
 *
 * Mirror of `gws-check-health.ts`. Processes `entra_check_health` Bull
 * jobs: for the agency in the job payload, runs the Entra liveness
 * probe (client_credentials token exchange against the Microsoft
 * login endpoint) against every `identity_sources` row with
 * `plugin_key = 'entra-id'`, persists state transitions through the
 * shared orchestrator. See #988.
 */

import type Bull from 'bull';
import { runHealthChecksForAgencyByPlugin } from '../../../../lib/platform-health/orchestrator.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { checkEntra } from '../liveness.js';

interface JobResult {
  status: 'completed';
  jobType: 'entra_check_health';
  agencyId: string;
  checked: number;
  transitioned: number;
  notified: number;
}

export default async function entraCheckHealth(job: Bull.Job): Promise<JobResult> {
  const { tenantId, dryRun } = job.data as { tenantId: string; dryRun?: boolean };
  const { logger } = getRuntime();

  const results = await runHealthChecksForAgencyByPlugin({
    agencyId: tenantId,
    pluginKey: 'entra-id',
    livenessFn: checkEntra,
    dryRun: Boolean(dryRun),
  });

  const transitioned = results.filter((r) => r.transitioned);
  if (transitioned.length > 0) {
    logger.info('entra_check_health: transitions', {
      jobId: String(job.id),
      tenantId,
      transitions: transitioned.map(
        (r) => `${r.sourceId}:${r.previousState}→${r.newState}`,
      ),
    });
  }

  return {
    status: 'completed',
    jobType: 'entra_check_health',
    agencyId: tenantId,
    checked: results.length,
    transitioned: transitioned.length,
    notified: results.filter((r) => r.notified).length,
  };
}
