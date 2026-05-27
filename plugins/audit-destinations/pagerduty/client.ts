/**
 * PagerDuty Events API v2 delivery client.
 * https://developer.pagerduty.com/docs/events-api-v2/overview/
 *
 * Only severity=critical audit events translate to PagerDuty incidents.
 * Lower-severity events are silently dropped at formatBatch time so the
 * Bull worker still records them as "delivered" without spamming PD.
 */

import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { postJson } from '../common/http.js';

export type PagerDutyConfig = Record<string, never>;
export interface PagerDutyAuth {
  routingKey: string;
}

interface PdEventV2 {
  event_action: 'trigger';
  dedup_key: string;
  payload: {
    summary: string;
    source: string;
    severity: 'critical';
    component: string;
    timestamp: string;
    custom_details: Record<string, unknown>;
  };
}

export interface FormattedPagerDutyBatch {
  events: PdEventV2[];
}

function toPd(e: AuditEvent): PdEventV2 {
  return {
    event_action: 'trigger',
    dedup_key: `accesshive-${e.eventId}`,
    payload: {
      summary: `${e.eventType} — ${e.actor.email ?? e.actor.id ?? 'system'}`,
      source: e.source,
      severity: 'critical',
      component: 'audit',
      timestamp: e.timestamp,
      custom_details: {
        eventType: e.eventType,
        agencyId: e.agency.id,
        actor: e.actor,
        resource: e.resource,
        context: e.context,
      },
    },
  };
}

export function formatBatch(
  events: AuditEvent[],
  _config: Record<string, unknown>,
): FormattedPagerDutyBatch {
  return { events: events.filter((e) => e.severity === 'critical').map(toPd) };
}

const PD_URL = 'https://events.pagerduty.com/v2/enqueue';

export async function sendBatch(
  formatted: FormattedPagerDutyBatch,
  _config: PagerDutyConfig,
  auth: PagerDutyAuth,
  agencyId: string,
): Promise<SendResult> {
  // No-op when filtered to empty — still counts as successful "delivery".
  if (formatted.events.length === 0) return { success: true };

  for (const pdEvent of formatted.events) {
    const body = { routing_key: auth.routingKey, ...pdEvent };
    const r = await postJson(PD_URL, body, { agencyId });
    if (!r.success) return r;
  }
  return { success: true };
}

export async function sendTest(
  _config: PagerDutyConfig,
  auth: PagerDutyAuth,
  agencyId: string,
): Promise<SendResult> {
  const synthetic: PdEventV2 = {
    event_action: 'trigger',
    dedup_key: `accesshive-test-${Date.now()}`,
    payload: {
      summary: 'AccessHive Audit Settings — test event',
      source: 'accesshive',
      severity: 'critical',
      component: 'audit',
      timestamp: new Date().toISOString(),
      custom_details: { test: true, agencyId },
    },
  };
  return postJson(PD_URL, { routing_key: auth.routingKey, ...synthetic }, { agencyId });
}
