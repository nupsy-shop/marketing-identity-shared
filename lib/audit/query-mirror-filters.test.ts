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

import { queryAuditEventsFromMirror } from './query';

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
