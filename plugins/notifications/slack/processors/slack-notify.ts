import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function slackNotify(job: Bull.Job): Promise<JobResult> {
  const { logger } = getRuntime();
  const { tenantId, webhookUrl, message, blocks, channel } = job.data;

  if (!webhookUrl) {
    throw new Error('Missing required field: webhookUrl');
  }

  const body = JSON.stringify(
    blocks ? { blocks, channel } : { text: message || 'Notification from AccessHive', channel },
  );

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Slack notification failed (${res.status}): ${text.substring(0, 200)}`);
  }

  logger.info('Slack notification sent', { jobId: job.id, tenantId, channel });
  return { status: 'completed', jobType: 'slack_notify' };
}
