import { describe, it, expect, vi, beforeEach } from 'vitest';

const { created, fakePrisma } = vi.hoisted(() => {
  const created: any[] = [];
  const fakePrisma = {
    auditEventsMirror: { createMany: async ({ data }: any) => { created.push(...data); } },
    integration_identities: {
      findMany: async ({ where }: any) =>
        where.identifier?.equals === 'syn@client.com' ? [{ id: 'idy-syn' }] : [],
    },
  };
  return { created, fakePrisma };
});

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

vi.mock('canonicalize', () => ({
  default: (v: unknown) => JSON.stringify(v),
}));

vi.mock('./minio-archive.js', () => ({
  putAuditBody: vi.fn().mockResolvedValue(undefined),
  auditBodyKey: (agencyId: string, eventId: string) => `${agencyId}/${eventId}.json`,
}));

vi.mock('./forward-dispatch.js', () => ({
  enqueueForwardJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../runtime.js', () => ({ getRuntime: () => ({ prisma: fakePrisma }) }));

import { __writeProjectionBatchForTest } from './publisher';

beforeEach(() => { created.length = 0; });

describe('writeProjectionBatch correlation', () => {
  it('stamps session_grant_id + attribution=bound for AccessHive-mediated events', async () => {
    await __writeProjectionBatchForTest([{
      eventId: 'e1', agencyId: 'a1', timestamp: new Date('2026-06-20T10:00:00Z'),
      forwardable: {
        eventType: 'pam.session.checkout', action: 'checkout', source: 'accesshive',
        actor: { id: 'op-1', email: 'operator@agency.com' },
        context: { session_grant_id: 'grant-1' },
      },
    } as any]);
    expect(created[0].sessionGrantId).toBe('grant-1');
    expect(created[0].attribution).toBe('bound');
    expect(created[0].identityId).toBeNull();
  });

  it('resolves identity + attribution=windowed for external events with no grant', async () => {
    await __writeProjectionBatchForTest([{
      eventId: 'e2', agencyId: 'a1', timestamp: new Date('2026-06-20T11:00:00Z'),
      forwardable: {
        eventType: 'platform.meta.ad.created', action: 'created', source: 'meta',
        actor: { id: 'm-1', email: 'syn@client.com' },
        context: { eventTime: '2026-06-20T10:58:00Z' },
      },
    } as any]);
    expect(created[0].identityId).toBe('idy-syn');
    expect(created[0].attribution).toBe('windowed');
    expect(created[0].occurredAt.toISOString()).toBe('2026-06-20T10:58:00.000Z');
    expect(created[0].sessionGrantId).toBeNull();
  });

  it('persists the top-level client.id verbatim, independent of resource demotion (#2360)', async () => {
    await __writeProjectionBatchForTest([{
      eventId: 'e4', agencyId: 'a1', timestamp: new Date('2026-06-21T09:00:00Z'),
      forwardable: {
        eventType: 'access.request.created', action: 'created', source: 'accesshive',
        actor: { id: 'op-1', email: 'operator@agency.com' },
        // client.id is set even though resource is demoted to a request (not the
        // client) — the new column must still capture the TRUE client id.
        client: { id: 'client-42', name: 'Acme' },
        resource: { type: 'access_request', id: 'req-7' },
        context: { session_grant_id: 'grant-9' },
      },
    } as any]);
    expect(created[0].clientId).toBe('client-42');
    expect(created[0].resourceType).toBe('access_request');
    expect(created[0].resourceId).toBe('req-7');
  });

  it('leaves clientId null when the event has no client', async () => {
    await __writeProjectionBatchForTest([{
      eventId: 'e5', agencyId: 'a1', timestamp: new Date('2026-06-21T09:05:00Z'),
      forwardable: {
        eventType: 'pam.session.checkout', action: 'checkout', source: 'accesshive',
        actor: { id: 'op-1', email: 'operator@agency.com' },
        context: { session_grant_id: 'grant-1' },
      },
    } as any]);
    expect(created[0].clientId).toBeNull();
  });

  it('leaves external system-actor events unattributed (fail-closed)', async () => {
    await __writeProjectionBatchForTest([{
      eventId: 'e3', agencyId: 'a1', timestamp: new Date('2026-06-20T12:00:00Z'),
      forwardable: {
        eventType: 'platform.meta.ad.created', action: 'created', source: 'meta',
        actor: { id: null, email: 'system' }, context: {},
      },
    } as any]);
    expect(created[0].identityId).toBeNull();
    expect(created[0].attribution).toBeNull();
  });
});
