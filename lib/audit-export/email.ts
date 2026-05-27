/**
 * Send the "your export is ready" email to each recipient on a scheduled
 * audit export. Wraps `sendEmailMessage` from the notifications/email
 * plugin, fanning out one delivery per recipient so a bad address on one
 * row doesn't poison the rest.
 *
 * Provider config: pulled from process.env. SendGrid is the default in
 * production; SMTP fallback works in dev when `SENDGRID_API_KEY` is unset
 * and a host is configured. No `notification_channels` row is required —
 * this is a system-emitted message, not a user-configured channel.
 */

import { sendEmailMessage, type EmailChannelConfig } from '../../plugins/notifications/email/client.js';
import { getRuntime } from '../runtime.js';

export interface ExportReadyEmailArgs {
  agencyId: string;
  agencySlug?: string | null;
  scheduleName: string;
  runIsoTimestamp: string;
  presignedUrl: string;
  recipients: string[];
}

export interface ExportEmailResult {
  attempted: number;
  delivered: number;
  failures: Array<{ recipient: string; error: string }>;
}

export async function sendExportReadyEmail(args: ExportReadyEmailArgs): Promise<ExportEmailResult> {
  const { logger } = getRuntime();

  const config: EmailChannelConfig = {
    provider: process.env.NOTIFICATION_EMAIL_PROVIDER || (process.env.SENDGRID_API_KEY ? 'sendgrid' : 'smtp'),
    apiKey: process.env.SENDGRID_API_KEY,
    fromName: process.env.NOTIFICATION_EMAIL_FROM_NAME || 'AccessHive',
    fromEmail: process.env.NOTIFICATION_EMAIL_FROM || 'no-reply@accesshive.io',
  };

  const result: ExportEmailResult = { attempted: 0, delivered: 0, failures: [] };

  const title = `Your audit export is ready: ${args.scheduleName}`;
  const body = renderBody(args);

  for (const recipient of args.recipients) {
    result.attempted++;
    try {
      const send = await sendEmailMessage(
        args.agencyId,
        { ...config, recipients: recipient },
        {
          title,
          body,
          severity: 'info',
          eventType: 'audit.export.delivered',
          timestamp: args.runIsoTimestamp,
          actionUrl: args.presignedUrl,
          metadata: { scheduleName: args.scheduleName },
        },
      );
      if (send.ok) {
        result.delivered++;
      } else {
        result.failures.push({ recipient, error: send.error || `status ${send.status}` });
      }
    } catch (err) {
      result.failures.push({ recipient, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (result.failures.length > 0) {
    logger.warn('[audit-export] some recipients failed to receive export email', {
      agencyId: args.agencyId,
      scheduleName: args.scheduleName,
      failed: result.failures.length,
      attempted: result.attempted,
    });
  }

  return result;
}

function renderBody(args: ExportReadyEmailArgs): string {
  const slug = args.agencySlug ? ` for <strong>${escapeHtml(args.agencySlug)}</strong>` : '';
  return [
    `<p>Your scheduled audit export <strong>${escapeHtml(args.scheduleName)}</strong>${slug} ran at ${escapeHtml(args.runIsoTimestamp)} UTC.</p>`,
    `<p>The link below expires in 7 days:</p>`,
    `<p><a href="${args.presignedUrl}">Download export</a></p>`,
  ].join('\n');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
