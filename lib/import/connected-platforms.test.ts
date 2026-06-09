import { describe, test, expect } from 'vitest';
import { setRuntime } from '../runtime.js';
import { getConnectedPlatformsByKey } from './connected-platforms.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };

describe('getConnectedPlatformsByKey (shared)', () => {
  test('maps connected platforms by pluginKey (catalog slug), scoped by agency_id, drops null slug', async () => {
    const seenWhere: Array<Record<string, unknown>> = [];
    const prisma = {
      agency_platforms: {
        findMany: async (args: { where: Record<string, unknown> }) => {
          seenWhere.push(args.where);
          return [
            { id: 'ap-1', platformId: 'cat-shopify', catalog_platforms: { slug: 'shopify' } },
            { id: 'ap-2', platformId: 'cat-meta', catalog_platforms: { slug: 'meta' } },
            { id: 'ap-3', platformId: 'cat-legacy', catalog_platforms: null },
          ];
        },
      },
    };
    setRuntime({ prisma: prisma as any, logger });

    const map = await getConnectedPlatformsByKey('agency-1');
    // scoped by agency_id and excludes soft-deleted rows
    expect(seenWhere[0]).toMatchObject({ agency_id: 'agency-1', deletedAt: null });
    expect(map.get('shopify')).toEqual({
      pluginKey: 'shopify',
      platformId: 'cat-shopify',
      agencyPlatformId: 'ap-1',
    });
    expect(map.get('meta')?.agencyPlatformId).toBe('ap-2');
    expect(map.has('legacy')).toBe(false);
    expect(map.size).toBe(2);
  });
});
