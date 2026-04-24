/**
 * Slack Notification Processor — `slack_notify` job.
 *
 * Consumes jobs enqueued by `shared/lib/notifications/dispatch.ts`. The
 * job payload carries the notification_channels row ID plus the event
 * type and structured context; this processor loads the channel config
 * from the DB, formats the human-readable message via the shared event
 * message catalogue, renders Block Kit via the shared Slack client, and
 * posts to the webhook (through the override hook so E2E scenarios can
 * stub the response deterministically).
 *
 * Pre-PR-F history: the processor expected `{tenantId, webhookUrl,
 * message, blocks, channel}` and threw on line 1 because the only real
 * enqueue site was passing the dispatcher shape. Every production
 * `slack_notify` job silently bounced on retries until Bull gave up. The
 * architecture doc always said "Bull is the delivery path"; the code just
 * hadn't been fixed to match.
 *
 * Failure taxonomy:
 *   - Channel row missing / inactive / misconfigured → return `skipped`.
 *     This is a config problem, not a transient failure — retries won't
 *     help and the job has succeeded in the Bull sense.
 *   - Slack returns 4xx → return `failed`. Non-retryable; operator needs
 *     to rotate the webhook. Bull's default retry policy would spam
 *     Slack for hours otherwise.
 *   - Slack returns 5xx, network error, timeout → throw. Bull retries
 *     with exponential backoff, which is the correct response to a
 *     transient upstream problem.
 */
import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { formatEventMessage } from '../../common/event-messages.js';
import {
  buildBlockKitPayload,
  postSlack,
  type SlackChannelConfig,
} from '../client.js';

interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: string;
  reason?: string;
  deliveryStatus?: number;
}

interface SlackJobData {
  /** Agency owning the notification (RLS + override scope). */
  tenantId: string;
  /** notification_channels row id. Config/webhookUrl come from this row. */
  channelId: string;
  /** Dot-namespaced event type (e.g. 'jml.leaver'). */
  eventType: string;
  /** Structured context passed through from the dispatcher. */
  context: Record<string, unknown>;
}

export default async function slackNotify(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, channelId, eventType, context } = job.data as SlackJobData;

  if (!tenantId || !channelId || !eventType) {
    // Malformed payload. Earlier pre-checks in the dispatcher should keep
    // this from happening; skipping (vs throwing) avoids poisoning the
    // queue if a stale payload from a pre-PR-F enqueue is somehow still
    // in flight.
    logger.warn('slack_notify: missing required fields, skipping', {
      jobId: String(job.id),
      hasTenantId: !!tenantId,
      hasChannelId: !!channelId,
      hasEventType: !!eventType,
    });
    return {
      status: 'skipped',
      jobType: 'slack_notify',
      reason: 'missing required fields (tenantId/channelId/eventType)',
    };
  }

  // 1. Load channel config. Scoped by agency_id — we NEVER trust the
  // channel.id alone because cross-tenant reads would be a classic IDOR.
  const channel = await prisma.notification_channels.findFirst({
    where: { id: channelId, agency_id: tenantId, is_active: true },
    select: { id: true, name: true, type: true, config: true },
  });

  if (!channel) {
    logger.info('slack_notify: channel not found or inactive, skipping', {
      jobId: String(job.id), tenantId, channelId,
    });
    return {
      status: 'skipped',
      jobType: 'slack_notify',
      reason: 'channel not found or inactive',
    };
  }

  const config = ((channel.config ?? {}) as SlackChannelConfig);
  if (!config.webhookUrl) {
    logger.warn('slack_notify: channel has no webhookUrl configured', {
      jobId: String(job.id), tenantId, channelId,
    });
    return {
      status: 'skipped',
      jobType: 'slack_notify',
      reason: 'channel.config.webhookUrl is not set',
    };
  }

  // 2. Format the message. `formatEventMessage` returns title/body/severity
  // from the shared catalog; unknown event types fall back to a stringified
  // context so we never swallow an event silently.
  const formatted = formatEventMessage(eventType, context);

  // 3. Build Block Kit payload via the shared client. The web-side Test
  // button uses the same builder; both paths produce byte-identical
  // payloads for the same inputs.
  const payload = buildBlockKitPayload(
    {
      title: formatted.title,
      body: formatted.body,
      severity: formatted.severity,
      eventType,
      timestamp: new Date().toISOString(),
      actionUrl: typeof context?.actionUrl === 'string' ? context.actionUrl : undefined,
      metadata: context,
    },
    config,
  );

  // 4. POST (or short-circuit via the E2E override hook).
  const result = await postSlack(tenantId, config.webhookUrl, payload);

  if (result.ok) {
    logger.info('slack_notify: delivered', {
      jobId: String(job.id),
      tenantId,
      channelId,
      eventType,
      status: result.status,
    });
    return {
      status: 'completed',
      jobType: 'slack_notify',
      deliveryStatus: result.status,
    };
  }

  // Slack/HTTP error. Distinguish client errors (non-retryable — the
  // operator must fix the channel) from server/transport errors (retry).
  const isClientError = result.status >= 400 && result.status < 500;
  logger.warn('slack_notify: delivery failed', {
    jobId: String(job.id),
    tenantId,
    channelId,
    eventType,
    status: result.status,
    error: result.error,
    willRetry: !isClientError,
  });

  if (isClientError) {
    // Return failed — Bull treats this as a completed-with-failure and
    // does NOT retry. The job lifecycle hook will record the status; an
    // audit event surfaces the failure to the admin UI.
    return {
      status: 'failed',
      jobType: 'slack_notify',
      reason: result.error ?? `Slack returned ${result.status}`,
      deliveryStatus: result.status,
    };
  }

  // Transient failure — throw so Bull retries with backoff.
  throw new Error(result.error ?? `Slack transient failure (status=${result.status})`);
}
