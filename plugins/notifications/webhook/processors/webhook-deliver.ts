import type Bull from 'bull';
import crypto from 'crypto';
import { getRuntime } from '../../../../lib/runtime.js';

interface JobResult {
  status: 'completed';
  jobType: string;
}

export default async function webhookDeliver(job: Bull.Job): Promise<JobResult> {
  const { logger } = getRuntime();
  const { tenantId, webhookUrl, event, payload, secret } = job.data;

  if (!webhookUrl) {
    throw new Error('Missing required field: webhookUrl');
  }

  const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'AccessHive-Webhook/1.0',
  };

  // HMAC signature if secret provided
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    headers['X-Signature-256'] = `sha256=${signature}`;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Webhook delivery failed (${res.status}): ${text.substring(0, 200)}`);
  }

  logger.info('Webhook delivered', { jobId: job.id, tenantId, webhookUrl, status: res.status });
  return { status: 'completed', jobType: 'webhook_deliver' };
}
