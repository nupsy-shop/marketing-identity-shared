/**
 * Splunk HTTP Event Collector (HEC) delivery client.
 * https://docs.splunk.com/Documentation/Splunk/latest/Data/UsetheHTTPEventCollector
 */

import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { buildTestEvent } from '../common/test-event.js';

export interface SplunkConfig {
  hecUrl: string;        // base URL incl. port, e.g. https://splunk.example.com:8088
  sourcetype: string;    // typically 'accesshive:audit'
  index: string;         // Splunk index name
}
export interface SplunkAuth {
  hecToken: string;
}

interface HecEvent {
  time: number;          // epoch seconds
  source: string;
  sourcetype: string;
  index: string;
  event: AuditEvent;
}

function toHec(e: AuditEvent, config: { sourcetype: string; index: string }): HecEvent {
  return {
    time: Math.floor(new Date(e.timestamp).getTime() / 1000),
    source: e.source,
    sourcetype: config.sourcetype,
    index: config.index,
    event: e,
  };
}

export function formatBatch(events: AuditEvent[], config: { sourcetype: string; index: string }): string {
  return events.map((e) => JSON.stringify(toHec(e, config))).join('\n') + '\n';
}

function collectorUrl(hecUrl: string): string {
  const trimmed = hecUrl.endsWith('/') ? hecUrl.slice(0, -1) : hecUrl;
  return `${trimmed}/services/collector/event`;
}

export async function sendBatch(
  formatted: string,
  config: SplunkConfig,
  auth: SplunkAuth,
  _agencyId: string,
): Promise<SendResult> {
  const url = collectorUrl(config.hecUrl);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Splunk ${auth.hecToken}`,
        'Content-Type': 'application/json',
      },
      body: formatted,
    });
    const elapsed = Date.now() - start;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        success: false,
        error: `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
        responseTimeMs: elapsed,
      };
    }
    return { success: true, responseTimeMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      responseTimeMs: elapsed,
    };
  }
}

export async function sendTest(config: SplunkConfig, auth: SplunkAuth, agencyId: string): Promise<SendResult> {
  const formatted = formatBatch([buildTestEvent(agencyId)], config);
  return sendBatch(formatted, config, auth, agencyId);
}
