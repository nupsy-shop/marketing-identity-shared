/**
 * Audit export formatters — CSV / JSON / NDJSON.
 *
 * Pure functions. Caller is responsible for loading the agency's masking
 * settings and applying `applyMask(...)` BEFORE calling these formatters,
 * OR can pass settings here and let `formatEvents` do it once.
 *
 * The CSV column order is fixed by the spec — see header in CSV_HEADERS.
 */

import { applyMask, type MaskedEvent, type MaskingSettings } from '../audit/masking.js';

export type ExportFormat = 'csv' | 'json' | 'ndjson';

export interface FormatResult {
  bytes: Buffer;
  contentType: string;
  extension: 'csv' | 'json' | 'ndjson';
}

export const CSV_HEADERS = [
  'eventId',
  'timestamp',
  'eventType',
  'severity',
  'source',
  'actor.email',
  'agency.id',
  'resource.type',
  'resource.id',
  'resource.name',
] as const;

export interface FormatOptions {
  format: ExportFormat;
  events: MaskedEvent[];
  masking: MaskingSettings;
  agencyId: string;
  /** When true, callers have already masked — skip the second pass. */
  alreadyMasked?: boolean;
}

export function formatEvents(opts: FormatOptions): FormatResult {
  const masked = opts.alreadyMasked
    ? opts.events
    : applyMask(opts.events, opts.masking, 'export', opts.agencyId);

  switch (opts.format) {
    case 'csv':
      return {
        bytes: Buffer.from(formatCsv(masked), 'utf8'),
        contentType: 'text/csv; charset=utf-8',
        extension: 'csv',
      };
    case 'json':
      return {
        bytes: Buffer.from(JSON.stringify(masked, null, 0), 'utf8'),
        contentType: 'application/json',
        extension: 'json',
      };
    case 'ndjson':
      return {
        bytes: Buffer.from(masked.map((e) => JSON.stringify(e)).join('\n') + (masked.length ? '\n' : ''), 'utf8'),
        contentType: 'application/x-ndjson',
        extension: 'ndjson',
      };
  }
}

function formatCsv(events: MaskedEvent[]): string {
  const lines: string[] = [CSV_HEADERS.join(',')];
  for (const e of events) {
    lines.push([
      csvCell(e.eventId),
      csvCell(e.timestamp),
      csvCell(e.eventType),
      csvCell(e.severity),
      csvCell(e.source),
      csvCell(e.actor?.email),
      csvCell(e.agency?.id),
      csvCell(e.resource?.type),
      csvCell(e.resource?.id),
      csvCell(e.resource?.name),
    ].join(','));
  }
  // RFC 4180: lines terminated with CRLF.
  return lines.join('\r\n') + '\r\n';
}

/**
 * Quote a cell per RFC 4180:
 *   - If value contains `"`, `,`, `\r`, or `\n`, wrap in double-quotes.
 *   - Embedded `"` becomes `""`.
 *   - undefined / null → empty string (unquoted).
 */
function csvCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (str === '') return '';
  const needsQuoting = /[",\r\n]/.test(str);
  if (!needsQuoting) return str;
  return `"${str.replace(/"/g, '""')}"`;
}
