/**
 * Tests for fetchUsersWithMfa — the MFA sync wrapper over fetchUsers.
 *
 * Uses a mock GraphMfaClient to isolate the logic from real Graph API calls.
 * Covers: 200 persist, TTL skip, 403 preserves prior + flags consent,
 * 429 retry-once success, persistent 429 skip, Retry-After wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchUsersWithMfa } from './directory.js';

const ONE_HOUR_MS = 60 * 60 * 1000;

describe('fetchUsersWithMfa', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let graphClient: { batch: ReturnType<typeof vi.fn>; fetchUsers: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    graphClient = {
      fetchUsers: vi.fn(),
      batch: vi.fn(),
    };
  });

  it('persists raw_attributes.mfa for users returned by /authentication/methods', async () => {
    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch.mockResolvedValue({
      responses: [
        {
          id: 'u1',
          status: 200,
          body: { value: [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }] },
        },
      ],
    });

    const result = await fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });
    expect(result.users[0].raw_attributes.mfa).toMatchObject({
      enrolled: true,
      methods: ['#microsoft.graph.fido2AuthenticationMethod'],
      syncedAt: expect.any(String),
    });
    expect(result.consentMissing).toBe(false);
  });

  it('skips users whose existing mfa.syncedAt is within the 1h TTL window', async () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    graphClient.fetchUsers.mockResolvedValue([
      {
        id: 'u-fresh',
        userPrincipalName: 'fresh@example.com',
        raw_attributes: { mfa: { enrolled: true, methods: [], syncedAt: recent } },
      },
      {
        id: 'u-stale',
        userPrincipalName: 'stale@example.com',
        raw_attributes: {
          mfa: {
            enrolled: false,
            methods: [],
            syncedAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
          },
        },
      },
    ]);
    graphClient.batch.mockResolvedValue({
      responses: [{ id: 'u-stale', status: 200, body: { value: [] } }],
    });

    await fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });

    expect(graphClient.batch).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batchPayload = graphClient.batch.mock.calls[0][0];
    expect(batchPayload.requests.map((r: { id: string }) => r.id)).toEqual(['u-stale']);
  });

  it('sets consentMissing=true and preserves prior mfa on 403', async () => {
    const prior = {
      enrolled: true,
      methods: ['#microsoft.graph.fido2AuthenticationMethod'],
      syncedAt: new Date(Date.now() - 2 * ONE_HOUR_MS).toISOString(),
    };
    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: { mfa: prior } },
    ]);
    graphClient.batch.mockResolvedValue({
      responses: [{ id: 'u1', status: 403, body: { error: { code: 'Authorization_RequestDenied' } } }],
    });

    const result = await fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });
    expect(result.users[0].raw_attributes.mfa).toEqual(prior);
    expect(result.consentMissing).toBe(true);
  });

  it('retries once on 429 honoring Retry-After', async () => {
    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch
      .mockResolvedValueOnce({
        responses: [{ id: 'u1', status: 429, headers: { 'Retry-After': '0' }, body: {} }],
      })
      .mockResolvedValueOnce({
        responses: [
          {
            id: 'u1',
            status: 200,
            body: { value: [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }] },
          },
        ],
      });

    const result = await fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });
    expect(graphClient.batch).toHaveBeenCalledTimes(2);
    expect(result.users[0].raw_attributes.mfa?.enrolled).toBe(true);
  });

  it('skips users whose persistent 429 prevents enrollment data; their mfa stays untouched', async () => {
    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch.mockResolvedValue({
      responses: [{ id: 'u1', status: 429, headers: { 'Retry-After': '0' }, body: {} }],
    });

    const result = await fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });
    expect(graphClient.batch).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(result.users[0].raw_attributes.mfa).toBeUndefined();
  });

  it('waits Retry-After seconds before retrying a 429 batch', async () => {
    vi.useFakeTimers();

    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch
      .mockResolvedValueOnce({
        responses: [{ id: 'u1', status: 429, headers: { 'Retry-After': '1' }, body: {} }],
      })
      .mockResolvedValueOnce({
        responses: [
          {
            id: 'u1',
            status: 200,
            body: { value: [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }] },
          },
        ],
      });

    // Start the call — it will pause at the setTimeout waiting for 1s.
    const resultPromise = fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });

    // The first batch call should have fired; retry hasn't happened yet.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;

    expect(graphClient.batch).toHaveBeenCalledTimes(2);
    expect(result.users[0].raw_attributes.mfa?.enrolled).toBe(true);

    vi.useRealTimers();
  });

  it('honors retry-after (lowercase) the same as Retry-After (capitalized)', async () => {
    // HTTP headers are case-insensitive; Graph may return either casing depending
    // on the proxy in front. This test verifies the case-insensitive getHeader
    // helper is used so throttle handling does not silently break.
    vi.useFakeTimers();

    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch
      .mockResolvedValueOnce({
        // Lowercase header — must be treated identically to 'Retry-After'.
        responses: [{ id: 'u1', status: 429, headers: { 'retry-after': '1' }, body: {} }],
      })
      .mockResolvedValueOnce({
        responses: [
          {
            id: 'u1',
            status: 200,
            body: { value: [{ '@odata.type': '#microsoft.graph.fido2AuthenticationMethod' }] },
          },
        ],
      });

    const resultPromise = fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });

    // Advance 1 s — the Retry-After value — to unblock the retry.
    await vi.advanceTimersByTimeAsync(1000);

    const result = await resultPromise;

    expect(graphClient.batch).toHaveBeenCalledTimes(2);
    expect(result.users[0].raw_attributes.mfa?.enrolled).toBe(true);

    vi.useRealTimers();
  });

  it('caps Retry-After wait at 30 s to prevent indefinite hangs', async () => {
    vi.useFakeTimers();

    graphClient.fetchUsers.mockResolvedValue([
      { id: 'u1', userPrincipalName: 'alice@example.com', raw_attributes: {} },
    ]);
    graphClient.batch
      .mockResolvedValueOnce({
        // Extremely large Retry-After — should be capped at 30s.
        responses: [{ id: 'u1', status: 429, headers: { 'Retry-After': '9999' }, body: {} }],
      })
      .mockResolvedValueOnce({
        responses: [{ id: 'u1', status: 200, body: { value: [] } }],
      });

    const resultPromise = fetchUsersWithMfa(graphClient, { agencyId: 'agency-1', now: Date.now() });

    // Advance exactly 30 s — the cap — not 9999 s.
    await vi.advanceTimersByTimeAsync(30_000);

    const result = await resultPromise;
    expect(graphClient.batch).toHaveBeenCalledTimes(2);
    expect(result.users[0].raw_attributes.mfa).toBeDefined();

    vi.useRealTimers();
  });
});
