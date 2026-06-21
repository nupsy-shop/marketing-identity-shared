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
