import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isIndexNotFound, ensureIndexExists } from './client.js';

function mockRes(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  process.env.SEARCHBOX_URL = 'http://heroku:pw@es.test';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isIndexNotFound', () => {
  it('is true only for a 404 carrying index_not_found_exception', () => {
    expect(isIndexNotFound(404, '{"error":{"type":"index_not_found_exception"}}')).toBe(true);
    expect(isIndexNotFound(404, 'no such index')).toBe(false);
    expect(isIndexNotFound(400, 'index_not_found_exception')).toBe(false);
    expect(isIndexNotFound(404, '')).toBe(false);
  });
});

describe('ensureIndexExists', () => {
  it('resolves when the PUT succeeds', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(200, { acknowledged: true }));
    await expect(ensureIndexExists('audit-2026.07')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('tolerates an already-existing index (no throw)', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(400, { error: { type: 'resource_already_exists_exception' } }));
    await expect(ensureIndexExists('audit-2026.07')).resolves.toBeUndefined();
  });
  it('swallows other creation errors (best-effort, no throw)', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(500, 'boom'));
    await expect(ensureIndexExists('audit-2026.07')).resolves.toBeUndefined();
  });
});
