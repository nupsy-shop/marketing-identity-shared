// shared/lib/import/template-assignments.test.ts
import { describe, test, expect } from 'vitest';
import { setRuntime } from '../runtime.js';
import { processTemplateAssignments } from './template-assignments.js';
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
  roleTemplates?: unknown;
  clients?: Array<{ id: string; name: string }>;
  platforms?: Array<{ id: string; platformId: string; slug: string | null }>;
}) {
  const createdRequests: any[] = [];
  const createdItems: any[] = [];
  const prisma = {
    agency_settings: {
      findFirst: async () => ({ role_templates: opts.roleTemplates ?? null }),
    },
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

describe('processTemplateAssignments', () => {
  test('known template with connected platformRoles creates request + one item per platformRole', async () => {
    const { prisma, createdRequests, createdItems } = makePrisma({
      roleTemplates: [
        {
          key: 'client-admin',
          label: 'Client Admin',
          platformRoles: [
            { platformKey: 'shopify', role: 'admin' },
            { platformKey: 'ga4', role: 'editor' },
          ],
        },
      ],
      clients: [{ id: 'client-1', name: 'Acme' }],
      platforms: [
        { id: 'ap-1', platformId: 'plat-shopify', slug: 'shopify' },
        { id: 'ap-2', platformId: 'plat-ga4', slug: 'ga4' },
      ],
    });
    setRuntime({ prisma, logger });

    const result = await processTemplateAssignments(
      [{ _rowIndex: 1, clientName: 'Acme', templateKey: 'client-admin' }],
      actor,
    );

    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(createdRequests).toHaveLength(1);
    expect(createdRequests[0].clientId).toBe('client-1');
    expect(createdRequests[0].agency_id).toBe('agency-1');
    expect(createdItems).toHaveLength(2);
    expect(createdItems.map(i => i.platformId).sort()).toEqual(
      ['plat-ga4', 'plat-shopify'],
    );
    for (const item of createdItems) {
      expect(item.agency_id).toBe('agency-1');
    }
  });

  test('unknown templateKey → failed with template-not-found message', async () => {
    const { prisma, createdRequests } = makePrisma({
      roleTemplates: [],
      clients: [{ id: 'client-1', name: 'Acme' }],
      platforms: [{ id: 'ap-1', platformId: 'plat-shopify', slug: 'shopify' }],
    });
    setRuntime({ prisma, logger });

    const result = await processTemplateAssignments(
      [{ _rowIndex: 2, clientName: 'Acme', templateKey: 'ghost' }],
      actor,
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(createdRequests).toHaveLength(0);
    expect(result.errors[0]).toMatchObject({
      row: 2,
      field: 'templateKey',
      message: 'Template "ghost" not found',
      reason: 'template_not_found',
    });
  });

  test('template platformRole on a non-connected platform is skipped (no item)', async () => {
    const { prisma, createdRequests, createdItems } = makePrisma({
      roleTemplates: [
        {
          key: 'client-admin',
          platformRoles: [
            { platformKey: 'shopify', role: 'admin' },
            { platformKey: 'meta', role: 'advertiser' },
          ],
        },
      ],
      clients: [{ id: 'client-1', name: 'Acme' }],
      platforms: [{ id: 'ap-1', platformId: 'plat-shopify', slug: 'shopify' }],
    });
    setRuntime({ prisma, logger });

    const result = await processTemplateAssignments(
      [{ _rowIndex: 3, clientName: 'Acme', templateKey: 'client-admin' }],
      actor,
    );

    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(createdRequests).toHaveLength(1);
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0].platformId).toBe('plat-shopify');
  });

  test('unknown client → failed with client-not-found message', async () => {
    const { prisma } = makePrisma({
      roleTemplates: [{ key: 'client-admin', platformRoles: [] }],
      clients: [],
      platforms: [],
    });
    setRuntime({ prisma, logger });

    const result = await processTemplateAssignments(
      [{ _rowIndex: 4, clientName: 'Ghost', templateKey: 'client-admin' }],
      actor,
    );

    expect(result.imported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]).toMatchObject({
      row: 4,
      field: 'clientName',
      message: 'Client "Ghost" not found',
      reason: 'client_not_found',
    });
  });
});
