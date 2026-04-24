/**
 * Slack delivery client — shared by the Bull processor (primary path for
 * real notifications) and the web-side `test()` helper (diagnostic button
 * in the channel settings UI).
 *
 * Single source of truth for:
 *   - the Block Kit payload shape we send to Slack, and
 *   - the provider-response-override hook that lets E2E scenarios stub
 *     Slack responses deterministically via the `provider_response_overrides`
 *     table (see `lib/http/provider-override-resolver.ts` for the contract).
 *
 * Before this module existed, the Bull processor did a bare `fetch` on a
 * raw payload while the web sender built rich Block Kit with the override
 * hook. That meant E2E overrides silently bypassed the production
 * notification path, and the Block Kit formatting couldn't be exercised
 * end-to-end. Both callers now go through `postSlack` so neither can drift
 * again.
 */
import { getRuntime } from '../../../lib/runtime.js';
import { SEVERITY_MAP } from '../common/event-messages.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface SlackNotificationMessage {
  title: string;
  body: string;
  severity: string;
  eventType: string;
  timestamp: string;
  actionUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface SlackChannelConfig {
  webhookUrl?: string;
  channel?: string;
  botName?: string;
  iconEmoji?: string;
}

export interface SlackPostResult {
  ok: boolean;
  status: number;
  error?: string;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  fields?: Array<{ type: string; text: string }>;
  elements?: Array<SlackBlockElement>;
}

interface SlackBlockElement {
  type: string;
  text?: string | { type: string; text: string };
  url?: string;
  style?: string;
}

export interface SlackPayload {
  blocks: SlackBlock[];
  attachments: Array<{ color: string; blocks: SlackBlock[] }>;
  channel?: string;
  username?: string;
  icon_emoji?: string;
}

// ─── Block Kit Builder ─────────────────────────────────────────────────────

/**
 * Render a `SlackNotificationMessage` into Slack's Block Kit payload.
 *
 * Severity maps to the attachment sidebar color (see SEVERITY_MAP). The
 * header / body / severity+event fields are always emitted; an action
 * button and a footer context line are appended when the source data
 * supports them.
 */
export function buildBlockKitPayload(
  message: SlackNotificationMessage,
  config: SlackChannelConfig,
): SlackPayload {
  const severityLabel = SEVERITY_MAP[message.severity]?.label || 'Info';
  const severityColor = SEVERITY_MAP[message.severity]?.color || '#3B82F6';

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: message.title, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message.body },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:* ${severityLabel}` },
        { type: 'mrkdwn', text: `*Event:* \`${message.eventType}\`` },
      ],
    },
  ];

  if (message.actionUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'View in AccessHive' },
          url: message.actionUrl,
          style: message.severity === 'critical' ? 'danger' : 'primary',
        },
      ],
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `_AccessHive | ${message.eventType} | ${message.timestamp}_` },
    ],
  });

  const payload: SlackPayload = {
    blocks,
    attachments: [{ color: severityColor, blocks: [] }],
  };
  if (config.channel) payload.channel = config.channel;
  if (config.botName) payload.username = config.botName;
  if (config.iconEmoji) payload.icon_emoji = config.iconEmoji;

  return payload;
}

// ─── Override-Aware POST ────────────────────────────────────────────────────

/**
 * POST a Slack payload to the given webhook URL. Consults the shared
 * provider-override resolver first (in E2E / non-prod environments) so a
 * matching `provider_response_overrides` row can short-circuit the network
 * call with a forced status + delay. Returns a plain `{ok, status, error?}`
 * result so callers can map to their own completion semantics — the Bull
 * processor translates `ok: false` into a retryable or terminal failure
 * based on the status code; the web-side Test button surfaces the result
 * directly to the operator.
 *
 * @param agencyId    Agency owning this outbound call (RLS scope for the
 *                    override table). REQUIRED — without it the override
 *                    path is bypassed, which would silently miss E2E stubs.
 * @param webhookUrl  Slack incoming webhook URL. Any matching substring in
 *                    `endpoint_match` triggers the override.
 * @param payload     Pre-built Block Kit payload from `buildBlockKitPayload`.
 */
export async function postSlack(
  agencyId: string,
  webhookUrl: string,
  payload: SlackPayload,
): Promise<SlackPostResult> {
  const { resolveProviderOverride } = getRuntime();
  if (resolveProviderOverride) {
    try {
      const override = await resolveProviderOverride(agencyId, 'slack', webhookUrl);
      if (override) {
        if (override.delayMs && override.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, override.delayMs));
        }
        if (override.status >= 400) {
          return {
            ok: false,
            status: override.status,
            error: `Slack webhook override (${override.status}): ${safeStringify(override.body) ?? ''}`,
          };
        }
        return { ok: true, status: override.status };
      }
    } catch {
      // Fail-closed: a resolver error never blocks the real call. The
      // resolver itself logs. Proceed to the live request.
    }
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `Slack webhook failed (${res.status}): ${text.substring(0, 200)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  }
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
