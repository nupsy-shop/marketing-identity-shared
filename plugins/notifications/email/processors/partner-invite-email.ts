/**
 * Partner-invite Email Processor — `partner_invite_email` job.
 *
 * Consumes `{agencyId, inviteId}` (enqueued fire-and-forget by the web-side
 * `createPartnerInvite` after the invite row commits). Loads the
 * agency-scoped `partner_invites` row, composes the invite email via the
 * shared template, and ships it through the same email client the
 * `email_send` processor and the web Test button use — one production path
 * for outbound mail.
 *
 * The token is read off the row here (never passed through the queue) to
 * build the public accept link.
 *
 * Failure taxonomy mirrors `email_send`:
 *   - Invite missing / not pending → skipped (the invite was superseded or
 *     already actioned; retrying won't change that).
 *   - Base URL not configured → failed (operator config gap; no retry).
 *   - Provider 4xx / 501 → failed (no retry).
 *   - Provider 5xx / network error → thrown (Bull retries).
 */
import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { recordTestDispatch } from '../../../../lib/notifications/dispatch-capture.js';
import {
  sendEmailMessage,
  type EmailChannelConfig,
} from '../client.js';
import { buildPartnerInviteEmail } from '../partner-invite-template.js';

interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: string;
  reason?: string;
  deliveryStatus?: number;
}

interface PartnerInviteEmailJobData {
  agencyId: string;
  inviteId: string;
}

export default async function partnerInviteEmail(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { agencyId, inviteId } = job.data as PartnerInviteEmailJobData;

  const invite = await prisma.partner_invites.findFirst({
    where: { id: inviteId, agency_id: agencyId },
    select: {
      token: true,
      email: true,
      status: true,
      note: true,
      expires_at: true,
      partners: { select: { name: true, primary_contact_name: true } },
      agencies: { select: { name: true } },
    },
  });

  if (!invite || invite.status !== 'pending') {
    return {
      status: 'skipped',
      jobType: 'partner_invite_email',
      reason: 'invite missing or not pending',
    };
  }

  // Public accept page lives on the web app's origin. OAUTH_REDIRECT_BASE_URL
  // is the canonical public origin in deployed envs; NEXT_PUBLIC_BASE_URL is
  // the local/dev fallback. Without either there is no link to send — treat
  // as a config gap (failed, no retry) rather than shipping a broken URL.
  const baseUrl = process.env.OAUTH_REDIRECT_BASE_URL || process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) {
    logger.warn('partner_invite_email: base url not configured, cannot build accept link', {
      jobId: String(job.id),
      agencyId,
      inviteId,
    });
    return {
      status: 'failed',
      jobType: 'partner_invite_email',
      reason: 'base url not configured',
    };
  }

  const acceptUrl = `${baseUrl}/partners/accept/${invite.token}`;

  // Provider config from process.env (same shape as the audit-export email
  // sender). No notification_channels row — this is a system-emitted message.
  const config: EmailChannelConfig = {
    provider: process.env.NOTIFICATION_EMAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? 'sendgrid' : 'smtp'),
    apiKey: process.env.SENDGRID_API_KEY,
    fromName: process.env.NOTIFICATION_EMAIL_FROM_NAME || 'AccessHive',
    fromEmail: process.env.NOTIFICATION_EMAIL_FROM || 'no-reply@accesshive.io',
    recipients: invite.email,
  };

  const message = buildPartnerInviteEmail({
    agencyName: invite.agencies?.name ?? 'Your agency',
    partnerName: invite.partners?.name ?? 'Partner',
    contactName: invite.partners?.primary_contact_name ?? null,
    note: invite.note,
    acceptUrl,
    expiresAt: invite.expires_at,
  });

  const result = await sendEmailMessage(agencyId, config, message);

  // Record the delivery outcome for test-tenant capture. Inert for real tenants.
  await recordTestDispatch({
    agencyId,
    eventType: 'partner.invited',
    channelType: 'email',
    status: result.ok ? 'delivered' : 'failed',
    detail: { httpStatus: result.status },
  }).catch(() => {});

  if (result.ok) {
    logger.info('partner_invite_email: delivered', {
      jobId: String(job.id),
      agencyId,
      inviteId,
      status: result.status,
    });
    return {
      status: 'completed',
      jobType: 'partner_invite_email',
      deliveryStatus: result.status,
    };
  }

  // Non-retryable: 4xx (client / config errors) + 501 Not Implemented (SES
  // stub — retrying won't make the integration exist).
  const isClientError = (result.status >= 400 && result.status < 500) || result.status === 501;
  logger.warn('partner_invite_email: delivery failed', {
    jobId: String(job.id),
    agencyId,
    inviteId,
    status: result.status,
    error: result.error,
    willRetry: !isClientError,
  });

  if (isClientError) {
    return {
      status: 'failed',
      jobType: 'partner_invite_email',
      reason: result.error ?? `Email returned ${result.status}`,
      deliveryStatus: result.status,
    };
  }

  throw new Error(result.error ?? `Email transient failure (status=${result.status})`);
}
