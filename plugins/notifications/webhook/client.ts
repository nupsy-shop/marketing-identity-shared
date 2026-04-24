/**
 * Generic-webhook delivery client — used by the Bull processor (the only
 * real delivery path; there's no web-side webhook sender).
 *
 * Responsible for:
 *   - Shaping the JSON body: `{ event, payload, timestamp }`.
 *   - Appending the HMAC-SHA256 signature header when the channel has a
 *     shared secret configured (`X-Signature-256: sha256=<hex>`).
 *   - Consulting the provider-override resolver so E2E scenarios can stub
 *     webhook responses deterministically via `provider_response_overrides`.
 *
 * Pattern mirrors `shared/plugins/notifications/slack/client.ts` — see
 * that file for the broader "why a shared client" rationale.
 */
import crypto from 'crypto';
import { getRuntime } from '../../../lib/runtime.js';

export interface WebhookBody {
  event: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface WebhookPostResult {
  ok: boolean;
  status: number;
  error?: string;
}

export function buildWebhookBody(
  eventType: string,
  context: Record<string, unknown>,
): WebhookBody {
  return {
    event: eventType,
    payload: context,
    timestamp: new Date().toISOString(),
  };
}

/**
 * POST a webhook payload with optional HMAC signing and the E2E override
 * hook. Returns `{ok, status, error?}`; the Bull processor converts this
 * into completed / failed / thrown based on the status class.
 *
 * @param agencyId   Agency owning this outbound call (override scope).
 * @param webhookUrl Destination URL.
 * @param body       Output of `buildWebhookBody`; serialised to JSON here.
 * @param secret     Optional HMAC shared secret. When present, adds the
 *                   `X-Signature-256: sha256=<hex>` header computed over
 *                   the exact serialised body.
 */
export async function postWebhook(
  agencyId: string,
  webhookUrl: string,
  body: WebhookBody,
  secret?: string | null,
): Promise<WebhookPostResult> {
  const serialised = JSON.stringify(body);

  const { resolveProviderOverride } = getRuntime();
  if (resolveProviderOverride) {
    try {
      const override = await resolveProviderOverride(agencyId, 'webhook', webhookUrl);
      if (override) {
        if (override.delayMs && override.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, override.delayMs));
        }
        if (override.status >= 400) {
          return {
            ok: false,
            status: override.status,
            error: `Webhook override (${override.status}): ${safeStringify(override.body) ?? ''}`,
          };
        }
        return { ok: true, status: override.status };
      }
    } catch {
      // Fail-closed — proceed to the real call.
    }
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'AccessHive-Webhook/1.0',
  };
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(serialised).digest('hex');
    headers['X-Signature-256'] = `sha256=${signature}`;
  }

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers,
      body: serialised,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `Webhook delivery failed (${res.status}): ${text.substring(0, 200)}`,
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
