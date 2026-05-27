/**
 * Syslog (RFC 5424) delivery client.
 *
 * Delegates the actual TCP / UDP / TLS transport to the existing
 * lib/siem/syslog-client.ts module so we don't reimplement socket handling.
 * Plan 7's decom must MOVE that module into plugins/audit-destinations/common/
 * (or copy its contents) before deleting lib/siem/.
 */

import {
  formatRfc5424,
  sendTcp,
  sendTls,
  sendUdp,
} from '../../../lib/siem/syslog-client.js';
import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { buildTestEvent } from '../common/test-event.js';

export interface SyslogConfig {
  host: string;
  port: number;
  protocol: 'tcp' | 'udp' | 'tls';
}

export interface SyslogAuth {
  authType: 'mtls' | 'none';
  clientCert?: string;
  clientKey?: string;
  allowSelfSigned?: boolean;
}

export interface FormattedSyslogBatch {
  messages: string[];
}

const FACILITY_LOCAL0 = 16;
const DEFAULT_TIMEOUT_MS = 30_000;

export function formatBatch(events: AuditEvent[], _config: Record<string, unknown>): FormattedSyslogBatch {
  return {
    messages: events.map((e) =>
      formatRfc5424(e as unknown as Parameters<typeof formatRfc5424>[0], FACILITY_LOCAL0),
    ),
  };
}

export async function sendBatch(
  formatted: FormattedSyslogBatch,
  config: SyslogConfig,
  auth: SyslogAuth,
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

export async function sendTest(config: SyslogConfig, auth: SyslogAuth, agencyId: string): Promise<SendResult> {
  const formatted = formatBatch([buildTestEvent(agencyId)], {});
  return sendBatch(formatted, config, auth, agencyId);
}
