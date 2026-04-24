/**
 * Email delivery client — shared by the Bull processor (primary path for
 * real notifications) and the web-side `test()` helper (Test button in
 * the admin UI). Pattern mirrors `shared/plugins/notifications/slack/client.ts`.
 *
 * Provider dispatch lives here so both callers route through the same
 * code:
 *   - SendGrid → override-aware HTTPS POST.
 *   - SMTP     → nodemailer if available, else a "simulated send" result
 *                so the test harness doesn't explode when the module is
 *                absent from the runtime image (e.g. the Bull worker may
 *                not ship nodemailer). No real mail goes out in that case.
 *   - SES      → stub; returns an "unimplemented" error so the failure is
 *                visible rather than silently swallowed.
 */
import { getRuntime } from '../../../lib/runtime.js';
import { SEVERITY_MAP } from '../common/event-messages.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface EmailNotificationMessage {
  title: string;
  body: string;
  severity: string;
  eventType: string;
  timestamp: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface EmailChannelConfig {
  provider?: string;
  recipients?: string;
  apiKey?: string;
  fromName?: string;
  fromEmail?: string;
}

export interface EmailSendResult {
  ok: boolean;
  status: number;
  error?: string;
  simulated?: boolean;
}

// ─── HTML builder ──────────────────────────────────────────────────────────

export function buildEmailHtml(message: EmailNotificationMessage): string {
  const severityColor = SEVERITY_MAP[message.severity]?.color || '#3B82F6';
  const severityLabel = SEVERITY_MAP[message.severity]?.label || 'Info';

  const actionButton = message.actionUrl
    ? `<tr>
        <td style="padding: 16px 0 0 0;">
          <a href="${message.actionUrl}"
             style="display: inline-block; padding: 10px 24px; background-color: #465FFF; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: 500;">
            View in AccessHive
          </a>
        </td>
      </tr>`
    : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f3f4f6; padding: 32px 16px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
          <tr><td style="background-color: #1F2937; padding: 20px 24px;"><span style="color: #ffffff; font-size: 18px; font-weight: 600;">AccessHive</span></td></tr>
          <tr><td style="background-color: ${severityColor}; height: 4px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
          <tr>
            <td style="padding: 24px;">
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr><td><span style="display: inline-block; padding: 2px 8px; background-color: ${severityColor}20; color: ${severityColor}; border-radius: 4px; font-size: 12px; font-weight: 500; text-transform: uppercase;">${severityLabel}</span></td></tr>
                <tr><td style="padding: 12px 0 0 0;"><h2 style="margin: 0; color: #111827; font-size: 18px; font-weight: 600;">${message.title}</h2></td></tr>
                <tr><td style="padding: 8px 0 0 0; color: #4b5563; font-size: 14px; line-height: 1.6;">${message.body}</td></tr>
                ${actionButton}
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 16px 24px; border-top: 1px solid #e5e7eb; background-color: #f9fafb;">
              <p style="margin: 0; color: #9ca3af; font-size: 12px;">${message.eventType} &middot; ${message.timestamp}</p>
              <p style="margin: 4px 0 0 0; color: #9ca3af; font-size: 11px;">Sent by AccessHive. Manage notification preferences in Settings.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Deliver an email notification through the configured provider. Returns
 * a structured result the caller converts to its own completion shape —
 * the Bull processor maps status to completed / failed / thrown; the web
 * Test button surfaces success/error directly to the operator.
 */
export async function sendEmailMessage(
  agencyId: string,
  config: EmailChannelConfig,
  message: EmailNotificationMessage,
): Promise<EmailSendResult> {
  const provider = config.provider ?? 'smtp';
  const recipientList = (config.recipients ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);

  if (recipientList.length === 0) {
    // 400 rather than 0: this is a client-side config error (operator
    // hasn't set recipients). 0 is reserved for true transport errors
    // (fetch threw, DNS failure) which should be retried — config gaps
    // must not retry or Bull will hammer the same bad config 5 times.
    return { ok: false, status: 400, error: 'No valid recipients configured' };
  }

  const subject = `[AccessHive] ${message.title}`;
  const html = buildEmailHtml(message);

  switch (provider) {
    case 'sendgrid':
      return sendViaSendGrid(agencyId, recipientList, subject, html, config);
    case 'smtp':
      return sendViaSmtp(recipientList, subject, html, config);
    case 'ses':
      // 501 Not Implemented — terminal (operator must pick a different
      // provider; Bull must not retry since there's nothing to recover).
      return {
        ok: false,
        status: 501,
        error: 'AWS SES provider not yet implemented. Use SMTP or SendGrid.',
      };
    default:
      return { ok: false, status: 400, error: `Unknown provider: ${provider}` };
  }
}

// ─── SendGrid (override-aware) ─────────────────────────────────────────────

async function sendViaSendGrid(
  agencyId: string,
  recipients: string[],
  subject: string,
  html: string,
  config: EmailChannelConfig,
): Promise<EmailSendResult> {
  const key = config.apiKey || process.env.SENDGRID_API_KEY;
  if (!key) return { ok: false, status: 0, error: 'SendGrid API key not configured' };

  const url = 'https://api.sendgrid.com/v3/mail/send';

  const { resolveProviderOverride } = getRuntime();
  if (resolveProviderOverride) {
    try {
      const override = await resolveProviderOverride(agencyId, 'sendgrid', url);
      if (override) {
        if (override.delayMs && override.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, override.delayMs));
        }
        if (override.status >= 400) {
          return {
            ok: false,
            status: override.status,
            error: `SendGrid override (${override.status}): ${safeStringify(override.body) ?? ''}`,
          };
        }
        return { ok: true, status: override.status, simulated: true };
      }
    } catch {
      // Fail-closed — real call will run.
    }
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: recipients.map((email) => ({ email })) }],
        from: {
          email: config.fromEmail || 'notifications@accesshive.io',
          name: config.fromName || 'AccessHive',
        },
        subject,
        content: [{ type: 'text/html', value: html }],
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => 'Unknown error');
      return { ok: false, status: res.status, error: `SendGrid error (${res.status}): ${text}` };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

// ─── SMTP (nodemailer, optional) ───────────────────────────────────────────

async function sendViaSmtp(
  recipients: string[],
  subject: string,
  html: string,
  config: EmailChannelConfig,
): Promise<EmailSendResult> {
  // SMTP_HOST not set → simulate (useful for dev + for Bull worker images
  // that intentionally don't ship SMTP credentials). We return ok so the
  // dispatcher treats it as a completed delivery; callers that need to
  // observe real delivery should use SendGrid.
  if (!process.env.SMTP_HOST) {
    return { ok: true, status: 200, simulated: true };
  }

  let nodemailer: NodemailerModule;
  try {
    const nodemailerModule = await import('nodemailer');
    // nodemailer ships as both CJS and ESM — `.default` exists under CJS,
    // and the namespace itself is the module under ESM.
    nodemailer = ((nodemailerModule as { default?: NodemailerModule }).default
      ?? (nodemailerModule as unknown as NodemailerModule));
  } catch {
    return { ok: true, status: 200, simulated: true };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: `${config.fromName || 'AccessHive'} <${config.fromEmail || process.env.SMTP_FROM || 'noreply@accesshive.io'}>`,
      to: recipients.join(', '),
      subject,
      html,
    });
    return { ok: true, status: 200 };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
}

// ─── Internal types ────────────────────────────────────────────────────────

interface NodemailerTransporter {
  sendMail(options: { from: string; to: string; subject: string; html: string }): Promise<unknown>;
}

interface NodemailerModule {
  createTransport(options: {
    host: string;
    port: number;
    secure: boolean;
    auth: { user: string | undefined; pass: string | undefined };
  }): NodemailerTransporter;
}

function safeStringify(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}
