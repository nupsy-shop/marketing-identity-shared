/**
 * Slack delivery client — posts Block Kit messages to an Incoming Webhook.
 */

import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { postJson } from '../common/http.js';
import { buildTestEvent } from '../common/test-event.js';

export interface SlackConfig {
  webhookUrl: string;
}
export type SlackAuth = Record<string, never>;

const SEVERITY_COLOR: Record<AuditEvent['severity'], string> = {
  info: '#465fff',
  warning: '#dc6803',
  critical: '#d92d20',
};

interface SlackMessage {
  attachments: Array<{ color: string; blocks: unknown[] }>;
}

export interface FormattedSlackBatch {
  messages: SlackMessage[];
}

function buildMessage(e: AuditEvent): SlackMessage {
  return {
    attachments: [
      {
        color: SEVERITY_COLOR[e.severity],
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: e.eventType } },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Actor*\n${e.actor.email ?? e.actor.id ?? 'system'}` },
              { type: 'mrkdwn', text: `*Severity*\n${e.severity}` },
              { type: 'mrkdwn', text: `*Source*\n${e.source}` },
              { type: 'mrkdwn', text: `*Timestamp*\n${e.timestamp}` },
              ...(e.resource
                ? [{ type: 'mrkdwn', text: `*Resource*\n${e.resource.type ?? '?'} · ${e.resource.name ?? e.resource.id ?? '?'}` }]
                : []),
            ],
          },
        ],
      },
    ],
  };
}

export function formatBatch(events: AuditEvent[], _config: Record<string, unknown>): FormattedSlackBatch {
  return { messages: events.map(buildMessage) };
}

export async function sendBatch(
  formatted: FormattedSlackBatch,
  config: SlackConfig,
  _auth: SlackAuth,
  agencyId: string,
): Promise<SendResult> {
  for (const msg of formatted.messages) {
    const r = await postJson(config.webhookUrl, msg, { agencyId });
    if (!r.success) return r;
  }
  return { success: true };
}

export async function sendTest(config: SlackConfig, _auth: SlackAuth, agencyId: string): Promise<SendResult> {
  const msg = buildMessage(buildTestEvent(agencyId));
  return postJson(config.webhookUrl, msg, { agencyId });
}
