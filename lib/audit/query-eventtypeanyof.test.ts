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

describe('queryAuditEventsFromMirror eventTypeAnyOf', () => {
  it('compiles a mix of prefixes and exact types into a where.OR', async () => {
    await queryAuditEventsFromMirror({
      agencyId: 'a1',
      eventTypeAnyOf: ['pam.*', 'credential.rotated', 'identity.totp.*'],
    });
    expect(captured.where.agencyId).toBe('a1');
    expect(captured.where.OR).toEqual([
      { eventType: { startsWith: 'pam.' } },
      { eventType: { startsWith: 'identity.totp.' } },
      { eventType: { in: ['credential.rotated'] } },
    ]);
  });

  it('ignores eventTypeAnyOf when empty and leaves no OR', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', eventTypeAnyOf: [] });
    expect(captured.where.OR).toBeUndefined();
  });

  it('still supports the single eventType path unchanged', async () => {
    await queryAuditEventsFromMirror({ agencyId: 'a1', eventType: 'pam.*' });
    expect(captured.where.eventType).toEqual({ startsWith: 'pam.' });
    expect(captured.where.OR).toBeUndefined();
  });
});
