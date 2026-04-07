/**
 * GWS Suspend User — Plugin Processor
 *
 * Processes gws_suspend_user Bull jobs. Suspends a Google Workspace user
 * when their Service Identity is disabled.
 */

import type Bull from 'bull';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function gwsSuspendUser(job: Bull.Job): Promise<JobResult> {
  const { tenantId, email, googleUserId } = job.data;

  const { default: prisma } = await import('../../../../lib/prisma.js');
  const { logger } = await import('../../../../lib/logger.js');

  // 1. Load GWS source config
  const source = await (prisma as any).identity_sources.findFirst({
    where: {
      agency_id: tenantId,
      plugin_key: 'google-workspace',
      provisioning_enabled: true,
    },
  });

  if (!source) {
    logger.info({ jobId: job.id }, 'gws_suspend_user: no enabled GWS source, skipped');
    return { status: 'completed', jobType: 'gws_suspend_user' };
  }

  // 2. Resolve OAuth access token
  let accessToken: string | null = null;
  if (source.oauth_token_id) {
    const token = await (prisma as any).oauth_tokens.findUnique({
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

  await updateUser(accessToken, userKey, { suspended: true });

  logger.info({ jobId: job.id, userKey }, 'gws_suspend_user: user suspended in Google Workspace');

  return { status: 'completed', jobType: 'gws_suspend_user' };
}
