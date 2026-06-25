import { describe, it, expect, vi } from 'vitest';
import {
  computePollSince,
  eventDedupKey,
  shouldPublishEvent,
  loadSeenEventKeys,
} from './poll-window.js';

const now = new Date('2026-06-25T12:00:00.000Z');

describe('computePollSince', () => {
  it('subtracts the lookback window from the cursor', () => {
    const cursor = '2026-06-25T11:00:00.000Z';
    expect(computePollSince(cursor, { lookbackHours: 6, now }).toISOString())
      .toBe('2026-06-25T05:00:00.000Z');
  });
  it('clamps to the maxHours floor when the lookback would go too far back', () => {
    const cursor = '2026-06-25T11:30:00.000Z';
    expect(computePollSince(cursor, { lookbackHours: 48, maxHours: 24, now }).toISOString())
      .toBe('2026-06-24T12:00:00.000Z');
  });
  it('never returns a future since', () => {
    const cursor = '2026-06-25T20:00:00.000Z';
    expect(computePollSince(cursor, { lookbackHours: 0, now }).getTime())
      .toBe(now.getTime());
  });
  it('falls back to now-maxHours when the cursor is missing or invalid', () => {
    expect(computePollSince(null, { maxHours: 24, now }).toISOString())
      .toBe('2026-06-24T12:00:00.000Z');
    expect(computePollSince('not-a-date', { maxHours: 24, now }).toISOString())
      .toBe('2026-06-24T12:00:00.000Z');
  });
});

describe('eventDedupKey', () => {
  it('returns the trimmed uniqueQualifier when present', () => {
    expect(eventDedupKey('  abc123 ')).toBe('abc123');
  });
  it('returns null when absent or empty', () => {
    expect(eventDedupKey(null)).toBeNull();
    expect(eventDedupKey('')).toBeNull();
    expect(eventDedupKey('   ')).toBeNull();
  });
});

describe('shouldPublishEvent', () => {
  const seen = new Set(['seen-key']);
  it('skips a keyed event already in the seen-set', () => {
    expect(shouldPublishEvent({ key: 'seen-key', eventTimeMs: 1, seen, previousCursorMs: 0 })).toBe(false);
  });
  it('publishes a keyed event not in the seen-set', () => {
    expect(shouldPublishEvent({ key: 'fresh-key', eventTimeMs: 1, seen, previousCursorMs: 0 })).toBe(true);
  });
  it('keyless: publishes only when strictly after the previous cursor', () => {
    expect(shouldPublishEvent({ key: null, eventTimeMs: 100, seen, previousCursorMs: 50 })).toBe(true);
    expect(shouldPublishEvent({ key: null, eventTimeMs: 40, seen, previousCursorMs: 50 })).toBe(false);
  });
  it('keyless: publishes on the first run (no previous cursor)', () => {
    expect(shouldPublishEvent({ key: null, eventTimeMs: 40, seen, previousCursorMs: null })).toBe(true);
  });
});

describe('loadSeenEventKeys', () => {
  it('builds the key set from agency- and prefix-scoped mirror rows since `since`', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { resourceId: 'k1' }, { resourceId: 'k2' }, { resourceId: null }, { resourceId: 'k1' },
    ]);
    const prisma = { auditEventsMirror: { findMany } } as never;
    const since = new Date('2026-06-25T05:00:00.000Z');
    const set = await loadSeenEventKeys({ prisma, agencyId: 'ag-1', since, eventTypePrefix: 'platform.gws.' });
    expect(set).toEqual(new Set(['k1', 'k2']));
    expect(findMany).toHaveBeenCalledWith({
      where: { agencyId: 'ag-1', eventType: { startsWith: 'platform.gws.' }, occurredAt: { gte: since } },
      select: { resourceId: true },
    });
  });
});
