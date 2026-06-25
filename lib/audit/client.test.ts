import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isIndexNotFound, ensureIndexExists, indexDocument, bulkIndex } from './client.js';

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

describe('indexDocument self-heal', () => {
  const doc = { eventId: 'ev1', timestamp: '2026-07-02T00:00:00.000Z', eventType: 'x' } as never;

  it('happy path indexes once with no ensure calls', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(201, { result: 'created' }));
    const out = await indexDocument(doc);
    expect(out).toEqual({ result: 'created' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on index_not_found: ensures template + index, then retries to success', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes(404, { error: { type: 'index_not_found_exception' } })) // 1: PUT doc
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))                            // 2: PUT template
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))                            // 3: PUT index
      .mockResolvedValueOnce(mockRes(201, { result: 'created' }));                            // 4: PUT doc retry
    const out = await indexDocument(doc);
    expect(out).toEqual({ result: 'created' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/audit-2026.07') && !String(url).includes('_doc'))).toBe(true);
  });

  it('throws if the retry still 404s', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes(404, { error: { type: 'index_not_found_exception' } }))
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))
      .mockResolvedValueOnce(mockRes(404, { error: { type: 'index_not_found_exception' } }));
    await expect(indexDocument(doc)).rejects.toThrow(/ES index failed \(404\)/);
  });

  it('throws immediately on a non-index-not-found error, no ensure', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(400, { error: { type: 'mapper_parsing_exception' } }));
    await expect(indexDocument(doc)).rejects.toThrow(/ES index failed \(400\)/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('bulkIndex self-heal', () => {
  const docs = [{ eventId: 'a', timestamp: '2026-07-02T00:00:00.000Z' }] as never[];

  it('returns the response when no item hit a missing index (single call)', async () => {
    fetchMock.mockResolvedValueOnce(mockRes(200, { errors: false, items: [{ index: { _index: 'audit-2026.07', status: 201 } }] }));
    const out = await bulkIndex(docs);
    expect(out.errors).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on an item index_not_found: ensures the missing index, then retries the bulk once', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes(200, { errors: true, items: [{ index: { _index: 'audit-2026.07', status: 404, error: { type: 'index_not_found_exception' } } }] })) // 1: bulk
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))   // 2: PUT template
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))   // 3: PUT index
      .mockResolvedValueOnce(mockRes(200, { errors: false, items: [{ index: { _index: 'audit-2026.07', status: 201 } }] })); // 4: bulk retry
    const out = await bulkIndex(docs);
    expect(out.errors).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls.some(([url]) => String(url) === 'http://es.test/audit-2026.07')).toBe(true);
  });

  it('mixed batch: only the missing index is created, then the whole bulk is retried once', async () => {
    fetchMock
      .mockResolvedValueOnce(mockRes(200, { errors: true, items: [
        { index: { _index: 'audit-2026.06', status: 201 } },                                                  // already succeeded
        { index: { _index: 'audit-2026.07', status: 404, error: { type: 'index_not_found_exception' } } },     // missing
      ] }))
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))   // PUT template
      .mockResolvedValueOnce(mockRes(200, { acknowledged: true }))   // PUT audit-2026.07
      .mockResolvedValueOnce(mockRes(200, { errors: false, items: [
        { index: { _index: 'audit-2026.06', status: 200 } },  // re-sent, idempotent upsert
        { index: { _index: 'audit-2026.07', status: 201 } },
      ] }));
    const out = await bulkIndex(docs);
    expect(out.errors).toBe(false);
    // Only the missing index is created (the already-succeeded one is not re-created).
    const indexPuts = fetchMock.mock.calls.filter(([url, opts]) => (opts as { method?: string })?.method === 'PUT' && /\/audit-\d{4}\.\d{2}$/.test(String(url)));
    expect(indexPuts.map(([url]) => String(url))).toEqual(['http://es.test/audit-2026.07']);
  });
});
