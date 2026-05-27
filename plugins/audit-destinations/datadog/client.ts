/**
 * Datadog Logs API delivery client.
 * https://docs.datadoghq.com/api/latest/logs/#send-logs
 */

import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { postJson } from '../common/http.js';
import { buildTestEvent } from '../common/test-event.js';

export interface DatadogConfig {
  site: string; // datadoghq.com | datadoghq.eu | us3.datadoghq.com | etc.
}
export interface DatadogAuth {
  apiKey: string;
}

interface DatadogLog {
  ddsource: string;
  service: string;
  status: 'info' | 'warn' | 'error';
  message: string;
  ddtags: string;
  hostname: string;
  timestamp: string;
}

const SEVERITY_TO_STATUS: Record<AuditEvent['severity'], DatadogLog['status']> = {
  info: 'info',
  warning: 'warn',
  critical: 'error',
};

function toLog(e: AuditEvent): DatadogLog {
  const tags = [
    `agency_id:${e.agency.id}`,
    `event_type:${e.eventType}`,
    `source:${e.source}`,
    `severity:${e.severity}`,
  ];
  return {
    ddsource: 'accesshive',
    service: 'audit',
    status: SEVERITY_TO_STATUS[e.severity],
    hostname: 'accesshive.io',
    timestamp: e.timestamp,
    ddtags: tags.join(','),
    message: JSON.stringify(e),
  };
}

export function formatBatch(events: AuditEvent[], _config: Record<string, unknown>): DatadogLog[] {
  return events.map(toLog);
}

function siteUrl(site: string): string {
  return `https://http-intake.logs.${site}/api/v2/logs`;
}

export async function sendBatch(
  formatted: DatadogLog[],
  config: DatadogConfig,
  auth: DatadogAuth,
  agencyId: string,
): Promise<SendResult> {
  return postJson(siteUrl(config.site), formatted, {
    agencyId,
    headers: { 'DD-API-KEY': auth.apiKey },
  });
}

export async function sendTest(config: DatadogConfig, auth: DatadogAuth, agencyId: string): Promise<SendResult> {
  return sendBatch(formatBatch([buildTestEvent(agencyId)], {}), config, auth, agencyId);
}
