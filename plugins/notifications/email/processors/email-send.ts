/**
 * Email Notification Processor — `email_send` job.
 *
 * Consumes `{tenantId, channelId, eventType, context}` from the unified
 * dispatcher. Loads the notification_channels row, formats the message
 * via the shared event catalogue, and ships it through the shared email
 * client (which handles provider dispatch + override hook + nodemailer
 * optionality).
 *
 * Pre-PR-H this processor was a TODO stub that logged and returned
 * completed. Actual delivery was never wired; every `email_send` job was
 * a no-op. Now it delivers via the same client the web-side Test button
 * uses, so there's one production path for email.
 *
 * Failure taxonomy mirrors slack_notify:
 *   - Config gaps (missing row / no recipients / no provider) → skipped.
 *   - Provider 4xx → failed (no retry).
 *   - Provider 5xx / network / nodemailer error → thrown (Bull retries).
 */
import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { recordTestDispatch } from '../../../../lib/notifications/dispatch-capture.js';
import { formatEventMessage } from '../../common/event-messages.js';
import {
  sendEmailMessage,
  type EmailChannelConfig,
} from '../client.js';

interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: string;
  reason?: string;
  deliveryStatus?: number;
  simulated?: boolean;
}

interface EmailJobData {
  tenantId: string;
  channelId: string;
  eventType: string;
  context: Record<string, unknown>;
}

export default async function emailSend(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, channelId, eventType, context } = job.data as EmailJobData;

  if (!tenantId || !channelId || !eventType) {
    logger.warn('email_send: missing required fields, skipping', {
      jobId: String(job.id),
      hasTenantId: !!tenantId,
      hasChannelId: !!channelId,
      hasEventType: !!eventType,
    });
    return {
      status: 'skipped',
      jobType: 'email_send',
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
      jobType: 'email_send',
      reason: 'channel not found or inactive',
    };
  }

  const config = ((channel.config ?? {}) as EmailChannelConfig & { __e2e_force_status?: number });
  if (!config.recipients || config.recipients.trim().length === 0) {
    return {
      status: 'skipped',
      jobType: 'email_send',
      reason: 'channel.config.recipients is empty',
    };
  }

  // E2E forced-failure seam. See slack_notify for the full rationale. Same
  // approach: gate on the marker, skip real send, return (never throw) so
  // Bull does not retry. recordTestDispatch gates on is_test_tenant.
  if (config.__e2e_force_status !== undefined) {
    const httpStatus = config.__e2e_force_status;
    const ok = httpStatus >= 200 && httpStatus < 300;
    await recordTestDispatch({
      agencyId: tenantId,
      eventType,
      channelId,
      channelType: 'email',
      status: ok ? 'delivered' : 'failed',
      detail: { httpStatus, forced: true },
    }).catch(() => {});
    return {
      status: ok ? 'completed' : 'failed',
      jobType: 'email_send',
      reason: ok ? undefined : `forced failure (status=${httpStatus})`,
      deliveryStatus: httpStatus,
    };
  }

  const formatted = formatEventMessage(eventType, context);
  const result = await sendEmailMessage(tenantId, config, {
    title: formatted.title,
    body: formatted.body,
    severity: formatted.severity,
    eventType,
    timestamp: new Date().toISOString(),
    actionUrl: typeof context?.actionUrl === 'string' ? context.actionUrl : undefined,
    metadata: context,
  });

  // Record the delivery outcome for test-tenant capture. Inert for real tenants.
  await recordTestDispatch({
    agencyId: tenantId,
    eventType,
    channelId,
    channelType: 'email',
    status: result.ok ? 'delivered' : 'failed',
    detail: { httpStatus: result.status },
  }).catch(() => {});

  if (result.ok) {
    logger.info('email_send: delivered', {
      jobId: String(job.id),
      tenantId,
      channelId,
      eventType,
      status: result.status,
      simulated: result.simulated ?? false,
    });
    return {
      status: 'completed',
      jobType: 'email_send',
      deliveryStatus: result.status,
      simulated: result.simulated,
    };
  }

  // Non-retryable: 4xx (client / config errors) + 501 Not Implemented
  // (the stub response from the SES provider — retrying won't make the
  // integration exist).
  const isClientError = (result.status >= 400 && result.status < 500) || result.status === 501;
  logger.warn('email_send: delivery failed', {
    jobId: String(job.id),
    tenantId,
    channelId,
    eventType,
    status: result.status,
    error: result.error,
    willRetry: !isClientError,
  });

  if (isClientError) {
    return {
      status: 'failed',
      jobType: 'email_send',
      reason: result.error ?? `Email returned ${result.status}`,
      deliveryStatus: result.status,
    };
  }

  throw new Error(result.error ?? `Email transient failure (status=${result.status})`);
}
