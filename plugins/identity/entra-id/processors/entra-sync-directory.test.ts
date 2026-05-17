/**
 * Orchestrator-level tests for entraSyncDirectory.
 *
 * Focused on the two hardening changes from shared#94 review:
 *
 *   Fix 1 — Consent state derived from granted_scopes, not metadata flag.
 *     - entra.mfa_scope_missing audit event is still emitted on 403.
 *     - identity_sources.update is NOT called for the metadata path when
 *       consentMissing=true (no entraMfaConsentMissing write).
 *     - identity_sources.update is NOT called for the metadata path when
 *       consentMissing=false (no entraMfaConsentMissing clear).
 *
 *   Fix 2 — DB read is scoped to users present in Graph response.
 *     - entra_directory_users.findMany includes entra_user_id: { in: graphUserIds }.
 *     - The set of DB rows fetched matches Graph user count, not total tenant count.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRuntime, clearRuntime } from '../../../../lib/runtime.js';

// ─── Module-level mocks ─────────────────────────────────────────────────────

// Mock publishAuditEvent before the processor module is imported.
const mockPublishAuditEvent = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../../lib/audit/publisher.js', () => ({
  publishAuditEvent: mockPublishAuditEvent,
}));

// Mock resolve-access-token — always returns a valid token for these tests.
vi.mock('./resolve-access-token.js', () => ({
  resolveEntraAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
}));

// Mock the Graph API fetchers so no real HTTP calls are made.
const mockFetchUsers = vi.fn();
const mockFetchGroups = vi.fn().mockResolvedValue([]);
const mockFetchGroupMembers = vi.fn().mockResolvedValue([]);
// fetchUsersWithMfa is used by the orchestrator through the mfaClient adapter
// built inline. We mock the low-level fetchUsers so we control what Graph returns;
// fetchUsersWithMfa itself runs real logic (TTL, batch, 403 handling).
vi.mock('./api/directory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api/directory.js')>();
  return {
    ...actual,
    fetchUsers: mockFetchUsers,
    fetchGroups: mockFetchGroups,
    fetchGroupMembers: mockFetchGroupMembers,
  };
});

// Import processor AFTER mocks are registered.
const { default: entraSyncDirectory } = await import('./entra-sync-directory.js');

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeJob(tenantId = 'agency-abc') {
  return { id: 'job-1', data: { tenantId } } as any;
}

/** Minimal identity_source row as returned by prisma.identity_sources.findFirst */
function makeSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src-1',
    agency_id: 'agency-abc',
    plugin_key: 'entra-id',
    connection_state: 'connected',
    connection_config: {},
    metadata: {},
    granted_scopes: ['User.Read.All', 'Group.Read.All'],
    sync_interval_hours: 6,
    ...overrides,
  };
}

/** Minimal Graph user shape returned by fetchUsers (mocked). */
function makeGraphUser(id: string, upn: string) {
  return {
    id,
    userPrincipalName: upn,
    mail: upn,
    displayName: upn,
    givenName: null,
    surname: null,
    jobTitle: null,
    department: null,
    accountEnabled: true,
    userType: 'Member',
    createdDateTime: null,
  };
}

// ─── Prisma mock factory ─────────────────────────────────────────────────────

function makePrisma({
  source = makeSource(),
  dbUsers = [] as Array<{ entra_user_id: string; raw_attributes: unknown }>,
  totalDbUserCount = 0,
}: {
  source?: ReturnType<typeof makeSource> | null;
  dbUsers?: Array<{ entra_user_id: string; raw_attributes: unknown }>;
  totalDbUserCount?: number;
} = {}) {
  const identitySourcesUpdate = vi.fn().mockResolvedValue({});
  const entraDirectoryUsersFindMany = vi.fn().mockImplementation(({ where }) => {
    // Simulate the filter: if entra_user_id: { in: [...] } is present, return
    // only matching rows. Otherwise return all (simulates missing filter).
    if (where?.entra_user_id?.in) {
      const ids = new Set(where.entra_user_id.in as string[]);
      return Promise.resolve(dbUsers.filter((r) => ids.has(r.entra_user_id)));
    }
    // Unfiltered — return full set (wrong behavior that Fix 2 eliminates).
    return Promise.resolve(
      Array.from({ length: totalDbUserCount }, (_, i) => ({
        entra_user_id: `db-only-user-${i}`,
        raw_attributes: {},
      })),
    );
  });

  return {
    prisma: {
      identity_sources: {
        findFirst: vi.fn().mockResolvedValue(source),
        update: identitySourcesUpdate,
      },
      entra_directory_users: {
        findMany: entraDirectoryUsersFindMany,
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({}),
        upsert: vi.fn().mockResolvedValue({}),
      },
      entra_groups: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({ id: 'grp-1' }),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({}),
      },
      entra_group_members: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({}),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
    },
    identitySourcesUpdate,
    entraDirectoryUsersFindMany,
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('entraSyncDirectory — Fix 1: consent state derived from granted_scopes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGroups.mockResolvedValue([]);
    mockFetchGroupMembers.mockResolvedValue([]);
  });

  afterEach(() => {
    clearRuntime();
  });

  it('emits entra.mfa_scope_missing audit event when consentMissing=true', async () => {
    // Graph returns one user; the $batch call returns 403 for that user.
    const graphUser = makeGraphUser('u1', 'alice@corp.com');
    mockFetchUsers.mockResolvedValue([graphUser]);

    const { prisma, identitySourcesUpdate } = makePrisma({
      dbUsers: [{ entra_user_id: 'u1', raw_attributes: {} }],
    });

    // Simulate fetchUsersWithMfa returning consentMissing=true by making the
    // batch call return a 403. We do this by temporarily overriding global fetch.
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: 'u1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
        ],
      }),
    } as unknown as Response);

    const logger = makeLogger();
    setRuntime({ prisma: prisma as any, logger, enqueueJob: vi.fn().mockResolvedValue(null) });

    await entraSyncDirectory(makeJob());

    global.fetch = originalFetch;

    // Audit event must have been published.
    const auditCalls = mockPublishAuditEvent.mock.calls.map((c) => c[0]);
    const scopeMissingEvent = auditCalls.find((e) => e.eventType === 'entra.mfa_scope_missing');
    expect(scopeMissingEvent).toBeDefined();
    expect(scopeMissingEvent.agency.id).toBe('agency-abc');
    expect(scopeMissingEvent.resource.id).toBe('src-1');
  });

  it('does NOT write metadata.entraMfaConsentMissing=true when consentMissing=true', async () => {
    const graphUser = makeGraphUser('u1', 'alice@corp.com');
    mockFetchUsers.mockResolvedValue([graphUser]);

    const { prisma, identitySourcesUpdate } = makePrisma({
      dbUsers: [{ entra_user_id: 'u1', raw_attributes: {} }],
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: 'u1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } },
        ],
      }),
    } as unknown as Response);

    const logger = makeLogger();
    setRuntime({ prisma: prisma as any, logger, enqueueJob: vi.fn().mockResolvedValue(null) });

    await entraSyncDirectory(makeJob());

    global.fetch = originalFetch;

    // All update() calls must NOT touch the metadata path for entraMfaConsentMissing.
    for (const call of identitySourcesUpdate.mock.calls) {
      const data = call[0]?.data ?? {};
      expect(data).not.toHaveProperty('metadata');
    }
  });

  it('does NOT write metadata.entraMfaConsentMissing=false when consentMissing=false', async () => {
    // Source previously had the flag set to true (old behavior).
    const sourceWithFlag = makeSource({ metadata: { entraMfaConsentMissing: true } });
    const graphUser = makeGraphUser('u1', 'alice@corp.com');
    mockFetchUsers.mockResolvedValue([graphUser]);

    const { prisma, identitySourcesUpdate } = makePrisma({
      source: sourceWithFlag,
      dbUsers: [{ entra_user_id: 'u1', raw_attributes: {} }],
    });

    // Consent is present this run: 200 response.
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          {
            id: 'u1',
            status: 200,
            body: { value: [{ '@odata.type': '#microsoft.graph.passwordAuthenticationMethod' }] },
          },
        ],
      }),
    } as unknown as Response);

    const logger = makeLogger();
    setRuntime({ prisma: prisma as any, logger, enqueueJob: vi.fn().mockResolvedValue(null) });

    await entraSyncDirectory(makeJob());

    global.fetch = originalFetch;

    // The old code would clear the flag here. New code must not touch metadata at all.
    for (const call of identitySourcesUpdate.mock.calls) {
      const data = call[0]?.data ?? {};
      expect(data).not.toHaveProperty('metadata');
    }
  });
});

describe('entraSyncDirectory — Fix 2: DB read scoped to Graph user IDs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchGroups.mockResolvedValue([]);
    mockFetchGroupMembers.mockResolvedValue([]);
  });

  afterEach(() => {
    clearRuntime();
  });

  it('passes entra_user_id: { in: graphUserIds } to entra_directory_users.findMany', async () => {
    const graphUsers = [
      makeGraphUser('u1', 'alice@corp.com'),
      makeGraphUser('u2', 'bob@corp.com'),
    ];
    mockFetchUsers.mockResolvedValue(graphUsers);

    const { prisma, entraDirectoryUsersFindMany } = makePrisma({
      dbUsers: [
        { entra_user_id: 'u1', raw_attributes: {} },
        { entra_user_id: 'u2', raw_attributes: {} },
      ],
      totalDbUserCount: 500, // many more rows exist for this tenant
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: 'u1', status: 200, body: { value: [] } },
          { id: 'u2', status: 200, body: { value: [] } },
        ],
      }),
    } as unknown as Response);

    const logger = makeLogger();
    setRuntime({ prisma: prisma as any, logger, enqueueJob: vi.fn().mockResolvedValue(null) });

    await entraSyncDirectory(makeJob());

    global.fetch = originalFetch;

    // The MFA DB read inside mfaClient.fetchUsers() must include the scoped filter.
    // This is the first findMany call on entra_directory_users (before the
    // is_present_in_idp sweep which has a different where shape).
    const mfaFetchCall = entraDirectoryUsersFindMany.mock.calls.find((call) => {
      const where = call[0]?.where ?? {};
      return 'entra_user_id' in where && where.entra_user_id?.in !== undefined;
    });

    expect(mfaFetchCall).toBeDefined();

    const passedIds: string[] = mfaFetchCall[0].where.entra_user_id.in;
    expect(passedIds.sort()).toEqual(['u1', 'u2'].sort());
  });

  it('fetches only Graph-present rows, not the full tenant table', async () => {
    // 2 Graph users but 500 total rows in the tenant table.
    const graphUsers = [
      makeGraphUser('u1', 'alice@corp.com'),
      makeGraphUser('u2', 'bob@corp.com'),
    ];
    mockFetchUsers.mockResolvedValue(graphUsers);

    const { prisma, entraDirectoryUsersFindMany } = makePrisma({
      dbUsers: [
        { entra_user_id: 'u1', raw_attributes: {} },
        { entra_user_id: 'u2', raw_attributes: {} },
      ],
      totalDbUserCount: 500,
    });

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        responses: [
          { id: 'u1', status: 200, body: { value: [] } },
          { id: 'u2', status: 200, body: { value: [] } },
        ],
      }),
    } as unknown as Response);

    const logger = makeLogger();
    setRuntime({ prisma: prisma as any, logger, enqueueJob: vi.fn().mockResolvedValue(null) });

    await entraSyncDirectory(makeJob());

    global.fetch = originalFetch;

    // The MFA findMany call must have returned 2 rows (Graph count), not 500.
    // Because our mock filters by entra_user_id.in when the filter is present,
    // the return value will be 2 rows — confirming the filter was applied.
    const mfaFetchCall = entraDirectoryUsersFindMany.mock.calls.find((call) => {
      const where = call[0]?.where ?? {};
      return 'entra_user_id' in where && where.entra_user_id?.in !== undefined;
    });

    expect(mfaFetchCall).toBeDefined();
    const returnedRows = await entraDirectoryUsersFindMany(mfaFetchCall[0]);
    expect(returnedRows).toHaveLength(graphUsers.length);
  });
});
