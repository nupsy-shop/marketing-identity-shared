import { describe, it, expect } from 'vitest';
import { sanitizeContextForEs, rehydrateContext } from './client';

describe('sanitizeContextForEs', () => {
  it('serialises a structured context into a scalar contextJson and drops context', () => {
    const out = sanitizeContextForEs({ eventType: 'x', context: { skipped: 0, nested: { a: 1 } } });
    expect(out).not.toHaveProperty('context');
    expect(out.contextJson).toBe(JSON.stringify({ skipped: 0, nested: { a: 1 } }));
    expect(out.eventType).toBe('x');
  });

  it('is type-flip safe: the same path as scalar vs object both become a string', () => {
    const scalar = sanitizeContextForEs({ context: { skipped: 0 } });
    const object = sanitizeContextForEs({ context: { skipped: { count: 0 } } });
    // Neither emits a structured `context.skipped` path for ES to dynamic-map.
    expect(typeof scalar.contextJson).toBe('string');
    expect(typeof object.contextJson).toBe('string');
    expect(scalar).not.toHaveProperty('context');
    expect(object).not.toHaveProperty('context');
  });

  it('drops a null/undefined context entirely (no contextJson)', () => {
    expect(sanitizeContextForEs({ a: 1, context: null })).toEqual({ a: 1 });
    expect(sanitizeContextForEs({ a: 1, context: undefined })).toEqual({ a: 1 });
  });

  it('leaves a doc without a context field untouched', () => {
    const doc = { eventType: 'x', resourceId: 'r1' };
    expect(sanitizeContextForEs(doc)).toEqual(doc);
  });
});

describe('rehydrateContext', () => {
  it('round-trips: sanitize then rehydrate restores the original context', () => {
    const original = { eventType: 'x', context: { skipped: 0, nested: { a: 1 } } };
    const restored = rehydrateContext(sanitizeContextForEs(original));
    expect(restored).toEqual(original);
    expect(restored).not.toHaveProperty('contextJson');
  });

  it('falls back to an empty object on malformed contextJson (never throws)', () => {
    const out = rehydrateContext({ eventType: 'x', contextJson: '{not json' });
    expect(out.context).toEqual({});
    expect(out).not.toHaveProperty('contextJson');
  });

  it('passes through a legacy structured context (no contextJson)', () => {
    const legacy = { eventType: 'x', context: { skipped: 0 } };
    expect(rehydrateContext(legacy)).toEqual(legacy);
  });

  it('prefers a structured context and drops contextJson when both are present', () => {
    const out = rehydrateContext({ context: { real: true }, contextJson: JSON.stringify({ stale: true }) });
    expect(out.context).toEqual({ real: true });
    expect(out).not.toHaveProperty('contextJson');
  });

  it('is a no-op when there is no contextJson string', () => {
    const doc = { eventType: 'x', resourceId: 'r1' };
    expect(rehydrateContext(doc)).toEqual(doc);
  });
});
