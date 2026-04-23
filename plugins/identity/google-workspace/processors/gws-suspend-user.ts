/**
 * GWS Suspend User — Plugin Processor
 *
 * Processes gws_suspend_user Bull jobs. Suspends a Google Workspace user
 * when their Service Identity is disabled.
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function gwsSuspendUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, email, googleUserId } = job.data;
  const { prisma, logger } = getRuntime();

  // 1. Load GWS source config
  const source = await prisma.identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'google-workspace',
      provisioning_enabled: true,
    },
  });

  if (!source) {
    logger.info('gws_suspend_user: no enabled GWS source, skipped', { jobId: String(job.id) });
    return { status: 'completed', jobType: 'gws_suspend_user' };
  }

  // 2. Resolve OAuth access token
  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await prisma.oauth_tokens.findUnique({
      where: { id: source.oauth_token_id },
    });
    if (token && token.is_active !== false) {
      accessToken = token.access_token;
    }
  }

  if (!accessToken) {
    throw new Error('No valid OAuth token for Google Workspace — will retry');
  }

  // 3. Call GWS Admin API
  const { updateUser } = await import('./api/provisioning.js');
  const userKey = email || googleUserId;

  await updateUser(accessToken, userKey, { suspended: true }, tenantId);

  logger.info('gws_suspend_user: user suspended in Google Workspace', { jobId: String(job.id), userKey });

  return { status: 'completed', jobType: 'gws_suspend_user' };
}
