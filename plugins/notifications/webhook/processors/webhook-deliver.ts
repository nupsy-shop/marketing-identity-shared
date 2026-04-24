/**
 * Generic-Webhook Delivery Processor — `webhook_deliver` job.
 *
 * Consumes the dispatcher payload `{tenantId, channelId, eventType,
 * context}` emitted by `shared/lib/notifications/dispatch.ts`. Loads the
 * `notification_channels` row, renders the canonical JSON body via the
 * shared webhook client, HMAC-signs with the channel's shared secret,
 * and posts (or short-circuits via the E2E override hook).
 *
 * Pre-PR-H: the processor expected `{webhookUrl, event, payload, secret}`
 * and threw "Missing required field: webhookUrl" for every real job.
 * Same silent-retry-to-death pattern as the Slack processor had — see
 * PR F for the broader rationale.
 *
 * Failure taxonomy:
 *   - Config gaps (no row, inactive, no webhookUrl) → `skipped` (no retry).
 *   - Remote 4xx → `failed` (non-retryable; operator fixes the endpoint).
 *   - Remote 5xx / network / timeout → throws (Bull retries with backoff).
 */
import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { buildWebhookBody, postWebhook } from '../client.js';

interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: string;
  reason?: string;
  deliveryStatus?: number;
}

interface WebhookChannelConfig {
  webhookUrl?: string;
  secret?: string | null;
}

interface WebhookJobData {
  tenantId: string;
  channelId: string;
  eventType: string;
  context: Record<string, unknown>;
}

export default async function webhookDeliver(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, channelId, eventType, context } = job.data as WebhookJobData;

  if (!tenantId || !channelId || !eventType) {
    logger.warn('webhook_deliver: missing required fields, skipping', {
      jobId: String(job.id),
      hasTenantId: !!tenantId,
      hasChannelId: !!channelId,
      hasEventType: !!eventType,
    });
    return {
      status: 'skipped',
      jobType: 'webhook_deliver',
      reason: 'missing required fields (tenantId/channelId/eventType)',
    };
  }

  const channel = await prisma.notification_channels.findFirst({
    where: { id: channelId, agency_id: tenantId, is_active: true },
    select: { id: true, name: true, config: true },
  });
  if (!channel) {
    return {
      status: 'skipped',
      jobType: 'webhook_deliver',
      reason: 'channel not found or inactive',
    };
  }

  const config = ((channel.config ?? {}) as WebhookChannelConfig);
  if (!config.webhookUrl) {
    return {
      status: 'skipped',
      jobType: 'webhook_deliver',
      reason: 'channel.config.webhookUrl is not set',
    };
  }

  const body = buildWebhookBody(eventType, context);
  const result = await postWebhook(tenantId, config.webhookUrl, body, config.secret ?? undefined);

  if (result.ok) {
    logger.info('webhook_deliver: delivered', {
      jobId: String(job.id), tenantId, channelId, eventType, status: result.status,
    });
    return {
      status: 'completed',
      jobType: 'webhook_deliver',
      deliveryStatus: result.status,
    };
  }

  const isClientError = result.status >= 400 && result.status < 500;
  logger.warn('webhook_deliver: delivery failed', {
    jobId: String(job.id), tenantId, channelId, eventType,
    status: result.status, error: result.error, willRetry: !isClientError,
  });

  if (isClientError) {
    return {
      status: 'failed',
      jobType: 'webhook_deliver',
      reason: result.error ?? `Webhook returned ${result.status}`,
      deliveryStatus: result.status,
    };
  }

  throw new Error(result.error ?? `Webhook transient failure (status=${result.status})`);
}
