import { describe, test, expect } from 'vitest';
import { setRuntime } from '../runtime.js';
import { processClients } from './clients.js';
import type { ImportActor } from './types.js';

const actor: ImportActor = {
  id: 'actor-1', email: 'admin@trevox.agency', agencyId: 'agency-1', agencySlug: 'trevox',
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

function makePrismaMock(existingNames: string[]) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    clients: {
      findMany: async (_args: unknown) => existingNames.map((n) => ({ name: n })),
      create: async (args: { data: Record<string, unknown> }) => { created.push(args.data); return args.data; },
    },
  };
}

describe('processClients (shared)', () => {
  test('imports new clients, skips duplicates, fails missing-name; every create carries agency_id', async () => {
    const prisma = makePrismaMock(['acme']);
    setRuntime({ prisma: prisma as any, logger });
    const result = await processClients(
      [
        { _rowIndex: 1, name: 'Nova', contactEmail: 'a@nova.co' },
        { _rowIndex: 2, name: 'Acme' },
        { _rowIndex: 3, name: '' },
      ],
      actor,
    );
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(1);
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]!.agency_id).toBe('agency-1');
    expect(prisma.created[0]!.name).toBe('Nova');
  });
});
