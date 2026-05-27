/**
 * CEF-over-syslog delivery client.
 *
 * Each event becomes a CEF string (via lib/siem/cef-mapper.ts) wrapped in an
 * RFC 5424 envelope (via lib/siem/syslog-client.ts:formatRfc5424). Transport
 * (TCP / UDP / TLS) is shared with the plain-syslog plugin.
 */

import { formatRfc5424, sendTcp, sendTls, sendUdp } from '../../../lib/siem/syslog-client.js';
import { mapEventToCef } from '../../../lib/siem/cef-mapper.js';
import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { buildTestEvent } from '../common/test-event.js';

export interface CefSyslogConfig {
  host: string;
  port: number;
  protocol: 'tcp' | 'udp' | 'tls';
}
export interface CefSyslogAuth {
  authType: 'mtls' | 'none';
  clientCert?: string;
  clientKey?: string;
  allowSelfSigned?: boolean;
}

export interface FormattedCefSyslogBatch {
  messages: string[];
}

const FACILITY_LOCAL0 = 16;
const DEFAULT_TIMEOUT_MS = 30_000;

export function formatBatch(events: AuditEvent[], _config: Record<string, unknown>): FormattedCefSyslogBatch {
  return {
    messages: events.map((e) => {
      const cef = mapEventToCef(e as unknown as Parameters<typeof mapEventToCef>[0]);
      return formatRfc5424({ ...e, _cefPayload: cef } as unknown as Parameters<typeof formatRfc5424>[0], FACILITY_LOCAL0);
    }),
  };
}

export async function sendBatch(
  formatted: FormattedCefSyslogBatch,
  config: CefSyslogConfig,
  auth: CefSyslogAuth,
  _agencyId: string,
): Promise<SendResult> {
  switch (config.protocol) {
    case 'tcp':
      return sendTcp(formatted.messages, config.host, config.port, DEFAULT_TIMEOUT_MS);
    case 'udp':
      return sendUdp(formatted.messages, config.host, config.port);
    case 'tls':
      return sendTls(
        formatted.messages,
        config.host,
        config.port,
        {
          cert: auth.authType === 'mtls' ? auth.clientCert : undefined,
          key: auth.authType === 'mtls' ? auth.clientKey : undefined,
          rejectUnauthorized: !auth.allowSelfSigned,
          allowSelfSigned: auth.allowSelfSigned,
        },
        DEFAULT_TIMEOUT_MS,
      );
  }
}

export async function sendTest(config: CefSyslogConfig, auth: CefSyslogAuth, agencyId: string): Promise<SendResult> {
  const formatted = formatBatch([buildTestEvent(agencyId)], {});
  return sendBatch(formatted, config, auth, agencyId);
}
