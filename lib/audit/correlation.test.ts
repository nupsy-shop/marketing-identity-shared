import { describe, it, expect } from 'vitest';
import { isResolvableEmail, deriveOccurredAt, deriveAttribution, resolveIdentityIdByEmail } from './correlation';

describe('isResolvableEmail', () => {
  it('accepts a normal email', () => {
    expect(isResolvableEmail('analyst@client.com')).toBe(true);
  });
  it('rejects the system sentinel', () => {
    expect(isResolvableEmail('system')).toBe(false);
  });
  it('rejects the unknown sentinel', () => {
    expect(isResolvableEmail('unknown')).toBe(false);
  });
  it('rejects a display name (no @)', () => {
    expect(isResolvableEmail('John Doe')).toBe(false);
  });
  it('rejects null/empty', () => {
    expect(isResolvableEmail(null)).toBe(false);
    expect(isResolvableEmail('')).toBe(false);
  });
  it('rejects an address with an internal space', () => {
    expect(isResolvableEmail('user @client.com')).toBe(false);
  });
});

describe('deriveOccurredAt', () => {
  const captured = new Date('2026-06-20T10:00:00.000Z');
  it('prefers context.eventTime (Meta)', () => {
    const ctx = { eventTime: '2026-06-20T09:55:00.000Z' };
    expect(deriveOccurredAt(ctx, captured).toISOString()).toBe('2026-06-20T09:55:00.000Z');
  });
  it('falls back to context.published (Okta)', () => {
    const ctx = { published: '2026-06-20T09:50:00.000Z' };
    expect(deriveOccurredAt(ctx, captured).toISOString()).toBe('2026-06-20T09:50:00.000Z');
  });
  it('falls back to capturedAt when no platform time present (GWS)', () => {
    expect(deriveOccurredAt({}, captured).toISOString()).toBe(captured.toISOString());
  });
  it('falls back to capturedAt on an unparseable value', () => {
    expect(deriveOccurredAt({ eventTime: 'not-a-date' }, captured).toISOString())
      .toBe(captured.toISOString());
  });
});

describe('deriveAttribution', () => {
  it('is bound when a session_grant_id is present', () => {
    expect(deriveAttribution('grant-1', 'id-1')).toBe('bound');
  });
  it('is windowed when only an identity_id is present', () => {
    expect(deriveAttribution(null, 'id-1')).toBe('windowed');
  });
  it('is null when neither is present', () => {
    expect(deriveAttribution(null, null)).toBeNull();
  });
});

describe('resolveIdentityIdByEmail', () => {
  const make = (rows: Array<{ id: string }>, expectAgencyId = 'a') => ({
    integration_identities: {
      findMany: async (args: { where: { agency_id: string; identifier: { equals: string; mode: string } } }) => {
        // Security-relevant: the query MUST be agency-scoped and case-insensitive.
        expect(args.where.agency_id).toBe(expectAgencyId);
        expect(args.where.identifier.mode).toBe('insensitive');
        return rows;
      },
    },
  }) as unknown as import('@prisma/client').PrismaClient;

  it('returns the id on a single email match', async () => {
    const id = await resolveIdentityIdByEmail(make([{ id: 'idy-1' }]), 'a', 'x@c.com');
    expect(id).toBe('idy-1');
  });
  it('fails closed (null) on a non-email actor', async () => {
    const id = await resolveIdentityIdByEmail(make([{ id: 'idy-1' }]), 'a', 'system');
    expect(id).toBeNull();
  });
  it('fails closed (null) when multiple identities share the identifier', async () => {
    const id = await resolveIdentityIdByEmail(make([{ id: 'idy-1' }, { id: 'idy-2' }]), 'a', 'x@c.com');
    expect(id).toBeNull();
  });
  it('returns null when no identity matches', async () => {
    const id = await resolveIdentityIdByEmail(make([]), 'a', 'x@c.com');
    expect(id).toBeNull();
  });
});
