import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captured, fakePrisma } = vi.hoisted(() => {
  const captured: { where?: any } = {};
  const fakePrisma = {
    auditEventsMirror: {
      findMany: async (args: any) => { captured.where = args.where; return []; },
      count: async () => 0,
    },
  };
  return { captured, fakePrisma };
});
vi.mock('../runtime.js', () => ({ getRuntime: () => ({ prisma: fakePrisma }) }));

import { queryAuditEventsFromMirror, getActivityForResource, getActivityForClient } from './query';

beforeEach(() => { captured.where = undefined; });

describe('queryAuditEventsFromMirror actorEmail filter', () => {
  it('adds an actorEmail equality filter when provided', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', actorEmail: 'alice@example.com' });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.actorEmail).toBe('alice@example.com');
  });

  it('omits the actorEmail filter when absent', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1' });
    expect('actorEmail' in captured.where).toBe(false);
  });

  it('keeps the agency scope alongside actorEmail and resourceId', async () => {
    await queryAuditEventsFromMirror({
      agencyId: 'a1',
      actorEmail: 'bob@example.com',
      resourceId: 'src-1',
    });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.actorEmail).toBe('bob@example.com');
    expect(captured.where.resourceId).toBe('src-1');
  });
});

describe('queryAuditEventsFromMirror severity filter', () => {
  it('adds a severity equality filter when provided', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', severity: 'critical' });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.severity).toBe('critical');
  });

  it('omits the severity filter when absent', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1' });
    expect('severity' in captured.where).toBe(false);
  });
});

describe('queryAuditEventsFromMirror clientId filter (#2360 dashboard recent-activity)', () => {
  it('compiles a single clientId to an equality filter', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', clientId: 'client-1' });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.clientId).toBe('client-1');
  });

  it('compiles a clientId ARRAY to an `in` filter (no undercount across the set)', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', clientId: ['c1', 'c2', 'c3'] });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.clientId).toEqual({ in: ['c1', 'c2', 'c3'] });
  });

  it('omits the clientId filter when absent', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1' });
    expect('clientId' in captured.where).toBe(false);
  });
});

describe('getActivityForResource reads the mirror DIRECTLY, agency-scoped (#1924)', () => {
  it('scopes by agency + resourceType + resourceId (Campaign Activity tab path)', async () => {
    await getActivityForResource('agencyA', 'campaign', 'camp-1');
    expect(captured.where.agencyId).toBe('agencyA');
    expect(captured.where.resourceType).toBe('campaign');
    expect(captured.where.resourceId).toBe('camp-1');
    // Strictly this resource — no ES-only term leaks, no plugin-family OR-branch.
    expect('OR' in captured.where).toBe(false);
  });

  it('fails closed (empty feed, no mirror read) when agencyId is missing', async () => {
    const out = await getActivityForResource('', 'campaign', 'camp-1');
    expect(out).toEqual([]);
    // where was never set → findMany never invoked
    expect(captured.where).toBeUndefined();
  });
});

describe('getActivityForClient reads the mirror DIRECTLY, agency-scoped (#1924)', () => {
  it('scopes by agency + clientId (KAM client activity feed path)', async () => {
    await getActivityForClient('agencyA', 'client-9');
    expect(captured.where.agencyId).toBe('agencyA');
    expect(captured.where.clientId).toBe('client-9');
  });

  it('fails closed (empty feed) when agencyId is missing', async () => {
    const out = await getActivityForClient('', 'client-9');
    expect(out).toEqual([]);
    expect(captured.where).toBeUndefined();
  });
});

describe('queryAuditEventsFromMirror source-scoped feed (identity source activity)', () => {
  it('scopes strictly by agency + resourceType + resourceId (cross-tenant safe)', async () => {
    await queryAuditEventsFromMirror({
      agencyId: 'agencyA',
      resourceType: 'identity_source',
      resourceId: 'source-1',
    });
    // agencyId is always present → agency B querying agency A's source returns
    // nothing because the where-clause excludes it.
    expect(captured.where.agencyId).toBe('agencyA');
    expect(captured.where.resourceType).toBe('identity_source');
    expect(captured.where.resourceId).toBe('source-1');
    // No `source` (plugin-family) OR-branch — strictly this source's events.
    expect('source' in captured.where).toBe(false);
    expect('OR' in captured.where).toBe(false);
  });
});
