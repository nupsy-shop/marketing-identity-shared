/**
 * Unit tests for the audit-export formatters.
 *
 * Pure-function coverage:
 *   - CSV header order matches the spec exactly.
 *   - RFC 4180 quoting: commas, quotes, embedded newlines.
 *   - JSON / NDJSON round-trip preserves event shape.
 *   - Masking with viewer='export' redacts emails when piiMode='exports'.
 */
import { describe, it, expect } from 'vitest';
import { formatEvents, CSV_HEADERS } from './format.js';
import type { MaskedEvent, MaskingSettings } from '../audit/masking.js';

const NO_MASK: MaskingSettings = { piiMode: 'off', stripBodiesOnFailure: false, anonymizeAuditor: false };
const EXPORT_MASK: MaskingSettings = { piiMode: 'exports', stripBodiesOnFailure: false, anonymizeAuditor: false };

function event(over: Partial<MaskedEvent> = {}): MaskedEvent {
  return {
    eventId: 'evt-1',
    timestamp: '2026-05-27T00:00:00.000Z',
    eventType: 'identity.created',
    severity: 'info',
    source: 'accesshive',
    actor: { id: 'a1', email: 'alice@example.com' },
    agency: { id: 'ag-1' },
    resource: { type: 'user', id: 'u-1', name: 'Alice' },
    ...over,
  };
}

describe('formatEvents — CSV', () => {
  it('emits the exact 10-column header from the spec', () => {
    const r = formatEvents({ format: 'csv', events: [], masking: NO_MASK, agencyId: 'ag-1' });
    expect(r.bytes.toString('utf8')).toBe(CSV_HEADERS.join(',') + '\r\n');
    expect(r.extension).toBe('csv');
    expect(r.contentType).toBe('text/csv; charset=utf-8');
  });

  it('emits one row per event with the spec column order', () => {
    const r = formatEvents({ format: 'csv', events: [event()], masking: NO_MASK, agencyId: 'ag-1' });
    const lines = r.bytes.toString('utf8').split('\r\n');
    expect(lines[0]).toBe(CSV_HEADERS.join(','));
    expect(lines[1]).toBe('evt-1,2026-05-27T00:00:00.000Z,identity.created,info,accesshive,alice@example.com,ag-1,user,u-1,Alice');
  });

  it('quotes cells that contain commas, quotes, CR, or LF (RFC 4180)', () => {
    const r = formatEvents({
      format: 'csv',
      events: [event({ resource: { type: 'user', id: 'u-1', name: 'Doe, "John"\nJr.' } })],
      masking: NO_MASK,
      agencyId: 'ag-1',
    });
    expect(r.bytes.toString('utf8')).toContain('"Doe, ""John""\nJr."');
  });

  it('masks actor.email when piiMode=exports and viewer=export', () => {
    const r = formatEvents({ format: 'csv', events: [event()], masking: EXPORT_MASK, agencyId: 'ag-1' });
    expect(r.bytes.toString('utf8')).toContain('[redacted-email]');
    expect(r.bytes.toString('utf8')).not.toContain('alice@example.com');
  });
});

describe('formatEvents — JSON / NDJSON', () => {
  it('JSON emits a single array', () => {
    const r = formatEvents({ format: 'json', events: [event(), event({ eventId: 'evt-2' })], masking: NO_MASK, agencyId: 'ag-1' });
    expect(r.extension).toBe('json');
    expect(r.contentType).toBe('application/json');
    const parsed = JSON.parse(r.bytes.toString('utf8')) as MaskedEvent[];
    expect(parsed.map((e) => e.eventId)).toEqual(['evt-1', 'evt-2']);
  });

  it('NDJSON emits one JSON object per line, trailing newline', () => {
    const r = formatEvents({ format: 'ndjson', events: [event(), event({ eventId: 'evt-2' })], masking: NO_MASK, agencyId: 'ag-1' });
    expect(r.extension).toBe('ndjson');
    expect(r.contentType).toBe('application/x-ndjson');
    const text = r.bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).eventId).toBe('evt-1');
    expect(JSON.parse(lines[1]).eventId).toBe('evt-2');
  });

  it('NDJSON with zero events emits an empty buffer (no trailing newline)', () => {
    const r = formatEvents({ format: 'ndjson', events: [], masking: NO_MASK, agencyId: 'ag-1' });
    expect(r.bytes.length).toBe(0);
  });

  it('skips re-masking when alreadyMasked=true', () => {
    const r = formatEvents({
      format: 'json',
      events: [event()],
      masking: EXPORT_MASK,
      agencyId: 'ag-1',
      alreadyMasked: true,
    });
    const parsed = JSON.parse(r.bytes.toString('utf8')) as MaskedEvent[];
    expect(parsed[0].actor.email).toBe('alice@example.com');
  });
});
