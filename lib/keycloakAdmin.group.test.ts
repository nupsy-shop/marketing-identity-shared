import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the runtime so getAdminToken returns a stub token and baseUrl is defined.
vi.mock('./runtime.js', () => ({
  getRuntime: vi.fn(() => ({})),
}));

// Intercept global fetch so adminFetch's underlying HTTP calls are controlled.
const fetchMock = vi.fn<(...args: unknown[]) => Promise<Response>>();
vi.stubGlobal('fetch', fetchMock);

// Import after mocks are registered.
const { addKeycloakUserToGroup } = await import('./keycloakAdmin.js');

// Stub KEYCLOAK_ADMIN_BASE_URL and the admin token endpoint.
process.env.KEYCLOAK_ADMIN_BASE_URL = 'https://kc.example.com';
process.env.KEYCLOAK_ADMIN_CLIENT_ID = 'test-client';
process.env.KEYCLOAK_ADMIN_CLIENT_SECRET = 'test-secret';

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: { get: () => null },
  } as unknown as Response;
}

/** Return a fetch mock sequence for actual adminFetch calls.
 * The token is cached after the first test's token fetch, so subsequent
 * tests don't need a token fetch mock — just the API responses.
 */
function withResponses(...responses: Response[]) {
  for (const r of responses) {
    fetchMock.mockResolvedValueOnce(r);
  }
}

describe('addKeycloakUserToGroup', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('resolves the group by exact name and PUTs the user into it', async () => {
    // First test: token is not yet cached, so 3 calls: token + search + PUT
    fetchMock
      .mockResolvedValueOnce(makeResponse(200, { access_token: 'test-token', expires_in: 3600 }))
      .mockResolvedValueOnce(makeResponse(200, [{ id: 'grp-1', name: 'PamSyntheticIdentities' }]))
      .mockResolvedValueOnce(makeResponse(204, null));

    await addKeycloakUserToGroup('agency-trevox', 'kc-9', 'PamSyntheticIdentities', 'ag-1');

    // 3 calls: token, group search, PUT
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const calls = fetchMock.mock.calls as unknown[][];
    const groupSearchUrl = calls[1]?.[0] as string;
    const putUrl = calls[2]?.[0] as string;
    const putOpts = calls[2]?.[1] as RequestInit;

    expect(groupSearchUrl).toContain('/admin/realms/agency-trevox/groups?search=PamSyntheticIdentities&exact=true');
    expect(putUrl).toContain('/admin/realms/agency-trevox/users/kc-9/groups/grp-1');
    expect(putOpts.method).toBe('PUT');
  });

  it('throws if the group does not exist', async () => {
    // Token is cached from the first test. Only 1 API call needed.
    withResponses(makeResponse(200, []));

    await expect(
      addKeycloakUserToGroup('agency-trevox', 'kc-9', 'PamSyntheticIdentities'),
    ).rejects.toThrow(/PamSyntheticIdentities/);

    // Only 1 call: group-search (no PUT, no token since it's cached)
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
