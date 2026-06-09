// shared/lib/import/access-requests.test.ts
import { describe, test, expect } from 'vitest';
import { setRuntime } from '../runtime.js';
import { processAccessRequests } from './access-requests.js';
import type { ImportActor } from './types.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const actor: ImportActor = {
  id: 'user-1',
  email: 'admin@agency.test',
  agencyId: 'agency-1',
};

function makePrisma(opts: {
  clients?: Array<{ id: string; name: string }>;
  platforms?: Array<{ id: string; platformId: string; slug: string | null }>;
}) {
  const createdRequests: any[] = [];
  const createdItems: any[] = [];
  const prisma = {
    clients: {
      findMany: async () =>
        (opts.clients ?? []).map(c => ({ id: c.id, name: c.name })),
    },
    agency_platforms: {
      findMany: async () =>
        (opts.platforms ?? []).map(p => ({
          id: p.id,
          platformId: p.platformId,
          catalog_platforms: { slug: p.slug },
        })),
    },
    access_requests: {
      create: async ({ data }: { data: any }) => {
        createdRequests.push(data);
        return data;
      },
    },
    access_request_items: {
      create: async ({ data }: { data: any }) => {
        createdItems.push(data);
        return data;
      },
    },
  };
  return { prisma, createdRequests, createdItems };
}

describe('processAccessRequests', () => {
  test('known client + connected platform creates one request + one item with agency_id', async () => {
    const { prisma, createdRequests, createdItems } = makePrisma({
      clients: [{ id: 'client-1', name: 'Acme' }],
      platforms: [{ id: 'ap-1', platformId: 'plat-ga4', slug: 'ga4' }],
    });
    setRuntime({ prisma, logger });

    const result = await processAccessRequests(
      [{ _rowIndex: 1, clientName: 'Acme', platformKey: 'ga4', role: 'editor' }],
      actor,
    );

    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].clientId).toBe('client-1');
    expect(createdRequests[0].agency_id).toBe('agency-1');
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0].platformId).toBe('plat-ga4');
    expect(createdItems[0].agency_id).toBe('agency-1');
    expect(createdItems[0].role).toBe('editor');
  });

  test('unknown client → failed with not-found message', async () => {
    const { prisma } = makePrisma({
      clients: [],
      platforms: [{ id: 'ap-1', platformId: 'plat-ga4', slug: 'ga4' }],
    });
    setRuntime({ prisma, logger });

    const result = await processAccessRequests(
      [{ _rowIndex: 2, clientName: 'Ghost', platformKey: 'ga4', role: 'editor' }],
      actor,
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatchObject({
      row: 2,
      field: 'clientName',
      message: 'Client "Ghost" not found',
    });
  });

  test('platform not connected → failed with not-connected message', async () => {
    const { prisma } = makePrisma({
      clients: [{ id: 'client-1', name: 'Acme' }],
      platforms: [],
    });
    setRuntime({ prisma, logger });

    const result = await processAccessRequests(
      [{ _rowIndex: 3, clientName: 'Acme', platformKey: 'meta', role: 'editor' }],
      actor,
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatchObject({
      row: 3,
      field: 'platformKey',
      message: 'Platform "meta" not connected',
    });
  });
});
