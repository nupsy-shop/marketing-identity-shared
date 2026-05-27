/**
 * Syslog Client — RFC 5424 message formatting and socket management.
 *
 * Supports TCP, TLS (with mutual auth), and UDP transports.
 * Messages include structured data with AccessHive enterprise number.
 */

import net from 'net';
import tls from 'tls';
import dgram from 'dgram';

// ─── Types ──────────────────────────────────────────────────────────────────

interface SyslogEvent {
  severity?: string;
  timestamp?: string;
  eventType?: string;
  eventId?: string;
  source?: string;
  actor?: { email?: string };
  agency?: { slug?: string };
  _cefPayload?: string;
  [key: string]: unknown;
}

interface TransportResult {
  success: boolean;
  error?: string;
}

interface TlsConfig {
  cert?: string;
  key?: string;
  rejectUnauthorized?: boolean;
  allowSelfSigned?: boolean;
}

// ─── RFC 5424 Constants ──────────────────────────────────────────────────────

const FACILITY_LOCAL0 = 16;
const APP_NAME = 'AccessHive';
const HOSTNAME = 'accesshive.io';
const SD_ID = 'accesshive@49681'; // Private enterprise number placeholder

// Severity mapping for syslog (RFC 5424 severity codes)
const SYSLOG_SEVERITY: Record<string, number> = {
  info: 6,      // Informational
  warning: 4,   // Warning
  critical: 2,  // Critical
};

// ─── RFC 5424 Formatter ──────────────────────────────────────────────────────

/**
 * Format an event as an RFC 5424 syslog message.
 */
export function formatRfc5424(event: SyslogEvent, facility: number = FACILITY_LOCAL0, severity?: number): string {
  const sev = severity ?? (SYSLOG_SEVERITY[event.severity || ''] || 6);
  const pri = facility * 8 + sev;
  const version = 1;
  const timestamp = event.timestamp || new Date().toISOString();
  const procId = '-';
  const msgId = event.eventType || '-';

  // Structured data
  const sdParams: string[] = [];
  if (event.agency?.slug) sdParams.push(`agency="${escapeSdValue(event.agency.slug)}"`);
  if (event.actor?.email) sdParams.push(`actor="${escapeSdValue(event.actor.email)}"`);
  if (event.eventId) sdParams.push(`eventId="${escapeSdValue(event.eventId)}"`);
  if (event.source) sdParams.push(`source="${escapeSdValue(event.source)}"`);

  const sd = sdParams.length > 0
    ? `[${SD_ID} ${sdParams.join(' ')}]`
    : '-';

  // Message body (JSON payload)
  const msg = JSON.stringify(event);

  return `<${pri}>${version} ${timestamp} ${HOSTNAME} ${APP_NAME} ${procId} ${msgId} ${sd} ${msg}`;
}

/**
 * Escape a structured data parameter value per RFC 5424.
 */
function escapeSdValue(val: string | undefined): string {
  if (!val) return '';
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/]/g, '\\]');
}

// ─── TCP Transport ───────────────────────────────────────────────────────────

/**
 * Send messages via TCP.
 */
export function sendTcp(messages: string[], host: string, port: number, timeout: number = 30000): Promise<TransportResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;

    const done = (result: TransportResult): void => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeout);

    socket.on('timeout', () => done({ success: false, error: 'TCP connection timed out' }));
    socket.on('error', (err: Error) => done({ success: false, error: err.message }));

    socket.connect(port, host, () => {
      try {
        // RFC 5425: framing with octet count for TCP
        for (const msg of messages) {
          const framed = `${Buffer.byteLength(msg)} ${msg}`;
          socket.write(framed);
        }
        socket.end(() => done({ success: true }));
      } catch (err) {
        done({ success: false, error: (err as Error).message });
      }
    });
  });
}

// ─── TLS Transport ───────────────────────────────────────────────────────────

/**
 * Send messages via TLS (TCP + TLS).
 */
export function sendTls(messages: string[], host: string, port: number, tlsConfig: TlsConfig = {}, timeout: number = 30000): Promise<TransportResult> {
  return new Promise((resolve) => {
    let resolved = false;

    const done = (result: TransportResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const options: tls.ConnectionOptions = {
      host,
      port,
      rejectUnauthorized: tlsConfig.rejectUnauthorized !== false,
      timeout,
    };

    // Mutual TLS: client certificate
    if (tlsConfig.cert) options.cert = tlsConfig.cert;
    if (tlsConfig.key) options.key = tlsConfig.key;
    if (tlsConfig.allowSelfSigned) options.rejectUnauthorized = false;

    const socket = tls.connect(options, () => {
      try {
        for (const msg of messages) {
          const framed = `${Buffer.byteLength(msg)} ${msg}`;
          socket.write(framed);
        }
        socket.end(() => done({ success: true }));
      } catch (err) {
        done({ success: false, error: (err as Error).message });
      }
    });

    socket.on('timeout', () => {
      socket.destroy();
      done({ success: false, error: 'TLS connection timed out' });
    });
    socket.on('error', (err: Error) => {
      socket.destroy();
      done({ success: false, error: err.message });
    });
  });
}

// ─── UDP Transport ───────────────────────────────────────────────────────────

/**
 * Send messages via UDP.
 */
export function sendUdp(messages: string[], host: string, port: number): Promise<TransportResult> {
  return new Promise((resolve) => {
    const client = dgram.createSocket('udp4');
    let pending = messages.length;
    let hasError = false;

    if (pending === 0) {
      client.close();
      return resolve({ success: true });
    }

    for (const msg of messages) {
      const buf = Buffer.from(msg);
      client.send(buf, 0, buf.length, port, host, (err: Error | null) => {
        if (err && !hasError) {
          hasError = true;
          client.close();
          return resolve({ success: false, error: err.message });
        }
        pending--;
        if (pending <= 0 && !hasError) {
          client.close();
          resolve({ success: true });
        }
      });
    }
  });
}
