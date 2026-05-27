/**
 * Generic webhook delivery client.
 *
 * Two payload formats:
 *   - 'json' — { events: [<event>, ...] } (full event objects)
 *   - 'cef'  — { events: [{ cef: { ... } }, ...] } (CEF-shaped objects in JSON)
 *
 * Four auth modes: bearer, hmac (SHA-256 of body), basic, none.
 */

import crypto from 'crypto';
import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { postJson } from '../common/http.js';
import { buildTestEvent } from '../common/test-event.js';

export interface WebhookConfig {
  url: string;
  format: 'json' | 'cef';
}

export interface WebhookAuth {
  authType: 'bearer' | 'hmac' | 'basic' | 'none';
  token?: string;
  hmacSecret?: string;
  username?: string;
  password?: string;
}

interface FormattedBatch {
  events: unknown[];
}

export function formatBatch(events: AuditEvent[], config: { format: 'json' | 'cef' }): FormattedBatch {
  if (config.format === 'cef') {
    return {
      events: events.map((e) => ({
        cef: {
          name: e.eventType,
          severity: e.severity,
          deviceVendor: 'AccessHive',
          deviceProduct: 'audit',
          deviceEventClassId: e.eventType,
          extension: {
            agencyId: e.agency.id,
            actor: e.actor.email,
            timestamp: e.timestamp,
            ...(e.resource ? { resourceType: e.resource.type, resourceId: e.resource.id } : {}),
          },
        },
      })),
    };
  }
  return { events };
}

export async function sendBatch(
  formatted: FormattedBatch,
  config: WebhookConfig,
  auth: WebhookAuth,
  agencyId: string,
): Promise<SendResult> {
  const body = JSON.stringify(formatted);
  const headers: Record<string, string> = {};

  switch (auth.authType) {
    case 'bearer':
      if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
      break;
    case 'hmac':
      if (auth.hmacSecret) {
        const sig = crypto.createHmac('sha256', auth.hmacSecret).update(body).digest('hex');
        headers['X-AccessHive-Signature'] = `sha256=${sig}`;
      }
      break;
    case 'basic':
      if (auth.username && auth.password) {
        const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString('base64');
        headers.Authorization = `Basic ${b64}`;
      }
      break;
    case 'none':
      break;
  }

  // Use bodyString for ALL auth modes so HMAC signing and the sent bytes
  // are guaranteed identical. Cheaper too — one JSON.stringify pass.
  return postJson(config.url, undefined, { agencyId, headers, bodyString: body });
}

export async function sendTest(config: WebhookConfig, auth: WebhookAuth, agencyId: string): Promise<SendResult> {
  const formatted = formatBatch([buildTestEvent(agencyId)], config);
  return sendBatch(formatted, config, auth, agencyId);
}
