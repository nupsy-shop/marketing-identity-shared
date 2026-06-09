import { describe, test, expect } from 'vitest';
import { setRuntime } from '../runtime.js';
import { processTeamMembers } from './team-members.js';
import type { ImportActor } from './types.js';

const actor: ImportActor = {
  id: 'actor-1', email: 'admin@trevox.agency', agencyId: 'agency-1', agencySlug: 'trevox',
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };

interface MockOpts {
  activeUserCount?: number;
  localDirSource?: { id: string } | null;
  pendingInviteEmails?: string[];
  maxUsers?: number;
}

function makePrismaMock(opts: MockOpts = {}) {
  const activeUserCount = opts.activeUserCount ?? 0;
  const localDirSource = opts.localDirSource === undefined ? { id: 'src-local' } : opts.localDirSource;
  const pending = new Set(opts.pendingInviteEmails ?? []);
  const findFirstCalls: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];

  const prisma = {
    findFirstCalls,
    created,
    users: {
      findMany: async (_args: unknown) =>
        Array.from({ length: activeUserCount }, (_, i) => ({ id: `u${i}` })),
    },
    identity_sources: {
      findFirst: async (_args: unknown) => localDirSource,
    },
    user_invites: {
      findFirst: async (args: { where: Record<string, unknown> }) => {
        findFirstCalls.push(args.where);
        return pending.has(args.where.email as string) ? { id: 'existing' } : null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return args.data;
      },
    },
    agency_settings: {
      findFirst: async (_args: unknown) => ({
        tier: 'pro',
        cached_entitlements:
          opts.maxUsers === undefined
            ? null
            : {
                tier: 'pro',
                planCode: null,
                limits: { maxClients: Infinity, maxUsers: opts.maxUsers, maxPlatforms: Infinity, retentionDays: 30, apiRateLimit: 0 },
                features: {},
                connectors: { tier1Enabled: true, tier2Enabled: false, tier3Enabled: false },
                extraSeatPriceCents: 1500,
                source: 'lago',
              },
        cached_entitlements_at: new Date(),
      }),
    },
  };
  return prisma;
}

describe('processTeamMembers (shared)', () => {
  test('valid row creates a user_invites row scoped by agency_id and source_id', async () => {
    const prisma = makePrismaMock();
    setRuntime({ prisma: prisma as any, logger });
    const result = await processTeamMembers(
      [{ _rowIndex: 1, email: 'alice@agency.com', role: 'ops_admin', firstName: 'Alice', lastName: 'Jones' }],
      actor,
    );
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(0);
    expect(prisma.created).toHaveLength(1);
    expect(prisma.created[0]!.agency_id).toBe('agency-1');
    expect(prisma.created[0]!.source_id).toBe('src-local');
    expect(prisma.created[0]!.email).toBe('alice@agency.com');
  });

  test('SECURITY: every duplicate-invite findFirst is scoped by agency_id', async () => {
    const prisma = makePrismaMock({ pendingInviteEmails: ['dup@agency.com'] });
    setRuntime({ prisma: prisma as any, logger });
    const result = await processTeamMembers(
      [
        { _rowIndex: 1, email: 'dup@agency.com', role: 'viewer' },
        { _rowIndex: 2, email: 'fresh@agency.com', role: 'viewer' },
      ],
      actor,
    );
    expect(result.failed).toBe(1); // dup is a hard failure
    expect(result.imported).toBe(1); // fresh succeeds
    expect(prisma.findFirstCalls.length).toBe(2);
    for (const where of prisma.findFirstCalls) {
      expect(where.agency_id).toBe('agency-1');
      expect(where.status).toBe('pending');
    }
    const dupErr = result.errors.find((e) => e.reason === 'duplicate_invite');
    expect(dupErr?.message).toBe('A pending invite already exists for dup@agency.com');
  });

  test('invalid email and invalid role each fail with original messages', async () => {
    const prisma = makePrismaMock();
    setRuntime({ prisma: prisma as any, logger });
    const result = await processTeamMembers(
      [
        { _rowIndex: 1, email: 'not-an-email', role: 'viewer' },
        { _rowIndex: 2, email: 'bob@agency.com', role: 'not_a_role' },
      ],
      actor,
    );
    expect(result.failed).toBe(2);
    expect(result.imported).toBe(0);
    expect(result.errors[0]!.message).toBe('invalid_email: email is not a valid email');
    expect(result.errors[0]!.field).toBe('email');
    expect(result.errors[1]!.message).toBe('Invalid role "not_a_role"');
    expect(result.errors[1]!.field).toBe('role');
  });

  test('entitlement cap: rows beyond maxUsers fail with original message', async () => {
    // maxUsers=2, already 1 active user → only 1 more invite allowed
    const prisma = makePrismaMock({ activeUserCount: 1, maxUsers: 2 });
    setRuntime({ prisma: prisma as any, logger });
    const result = await processTeamMembers(
      [
        { _rowIndex: 1, email: 'a@agency.com', role: 'viewer' },
        { _rowIndex: 2, email: 'b@agency.com', role: 'viewer' },
      ],
      actor,
    );
    expect(result.imported).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors[0]!.message).toBe('User limit reached (2)');
    expect(result.errors[0]!.field).toBeNull();
  });

  test('missing local-directory source fails every row with the original message', async () => {
    const prisma = makePrismaMock({ localDirSource: null });
    setRuntime({ prisma: prisma as any, logger });
    const result = await processTeamMembers(
      [
        { _rowIndex: 1, email: 'a@agency.com', role: 'viewer' },
        { _rowIndex: 2, email: 'b@agency.com', role: 'viewer' },
      ],
      actor,
    );
    expect(result.failed).toBe(2);
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]!.message).toBe('Local directory identity source not configured for this agency');
  });
});
