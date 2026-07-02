/**
 * Durable-write failure hardening — flush must NOT silently drop events.
 *
 * Background (2026-07-02 incident): MinIO hit its disk floor and every
 * flush threw; the batch had already been spliced out of the buffer, so
 * ~6h of audit events across all tenants were dropped with only a
 * low-key `[Audit] flush error` console line. `publishAuditEvent`'s
 * return value counts publish CALLS, not durable writes, so callers
 * (e.g. the keycloak-events webhook returning `published: N`) reported
 * success the whole time.
 *
 * Contract under test:
 *   1. MinIO (putAuditBody) failure → the whole batch is REQUEUED and
 *      flushed successfully on the next attempt (no loss, no dupes).
 *   2. Per-agency chain-insert failure → only that agency's events are
 *      requeued; the succeeded agency's events are NOT re-inserted.
 *   3. The retry buffer is capped: overflow drops the OLDEST events and
 *      logs a loud AUDIT-EVENTS-DROPPED error (bounded memory during a
 *      long storage outage).
 *   4. Failures log a greppable `[Audit] DURABLE-WRITE FAILURE` line.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  putAuditBody: vi.fn(),
  insertChainMany: vi.fn(),
  enqueueJob: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

vi.mock('canonicalize', () => ({
  default: (v: unknown) => JSON.stringify(v),
}));

vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    prisma: {
      agency_settings: { findUnique: mocks.findUnique },
      $transaction: async (fn: (tx: unknown) => unknown) =>
        fn({
          auditEvent: {
            findFirst: async () => null,
            createMany: mocks.insertChainMany,
          },
          auditEsIndexState: { createMany: vi.fn().mockResolvedValue(undefined) },
        }),
    },
    enqueueJob: mocks.enqueueJob,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  }),
}));

vi.mock('./minio-archive.js', () => ({
  putAuditBody: mocks.putAuditBody,
  auditBodyKey: (agencyId: string, eventId: string) => `${agencyId}/${eventId}.json`,
}));

import {
  publishAuditEvent,
  flushAll,
  __resetPublisherForTest,
  __pendingCountForTest,
  __setMaxPendingForTest,
} from './publisher.js';

const AGENCY_A = '00000000-0000-0000-0000-00000000000a';
const AGENCY_B = '00000000-0000-0000-0000-00000000000b';

function chainRowsFor(call: unknown[]): Array<{ agencyId: string }> {
  const arg = (call as [{ data: Array<{ agencyId: string }> }])[0];
  return arg.data;
}

beforeEach(() => {
  __resetPublisherForTest();
  mocks.findUnique.mockResolvedValue(null); // no masking settings
  mocks.putAuditBody.mockReset().mockResolvedValue(undefined);
  mocks.insertChainMany.mockReset().mockResolvedValue(undefined);
});

describe('flush requeues on durable-write failure', () => {
  it('MinIO failure: batch is requeued and succeeds on the next flush (no loss)', async () => {
    await publishAuditEvent({ eventType: 'x.one', agency: { id: AGENCY_A } });

    mocks.putAuditBody.mockRejectedValueOnce(new Error('minio disk full'));
    await expect(flushAll()).rejects.toThrow('minio disk full');

    // Not dropped: still pending, nothing written to the chain.
    expect(__pendingCountForTest()).toBe(1);
    expect(mocks.insertChainMany).not.toHaveBeenCalled();

    // Storage recovers → next flush drains the same event exactly once.
    await flushAll();
    expect(__pendingCountForTest()).toBe(0);
    expect(mocks.insertChainMany).toHaveBeenCalledTimes(1);
  });

  it('per-agency chain failure: only the failed agency is requeued; the succeeded one is not re-inserted', async () => {
    await publishAuditEvent({ eventType: 'x.a', agency: { id: AGENCY_A } });
    await publishAuditEvent({ eventType: 'x.b', agency: { id: AGENCY_B } });

    // First createMany (agency A) succeeds, second (agency B) fails.
    mocks.insertChainMany
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('pg down'));

    await expect(flushAll()).rejects.toThrow('pg down');
    expect(__pendingCountForTest()).toBe(1); // only agency B's event

    mocks.insertChainMany.mockResolvedValue(undefined);
    await flushAll();
    expect(__pendingCountForTest()).toBe(0);

    // Agency A inserted exactly once across both flushes (never re-inserted);
    // agency B appears twice: the failed attempt + the successful retry.
    const agencies = mocks.insertChainMany.mock.calls
      .flatMap(c => chainRowsFor(c).map(r => r.agencyId));
    expect(agencies.filter(a => a === AGENCY_A)).toHaveLength(1);
    expect(agencies.filter(a => a === AGENCY_B)).toHaveLength(2);
  });

  it('logs a greppable DURABLE-WRITE FAILURE line on requeue', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await publishAuditEvent({ eventType: 'x.one', agency: { id: AGENCY_A } });
    mocks.putAuditBody.mockRejectedValueOnce(new Error('boom'));
    await expect(flushAll()).rejects.toThrow('boom');
    expect(spy.mock.calls.some(c => String(c[0]).includes('[Audit] DURABLE-WRITE FAILURE'))).toBe(true);
    spy.mockRestore();
  });

  it('caps the retry buffer: overflow drops the OLDEST events with a loud log', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    __setMaxPendingForTest(3); // shrink the cap so overflow is reachable cheaply
    try {
      mocks.putAuditBody.mockRejectedValue(new Error('minio disk full'));
      for (let i = 0; i < 5; i++) {
        await publishAuditEvent({ eventType: `x.${i}`, agency: { id: AGENCY_A } });
      }
      await flushAll().catch(() => {});
      expect(__pendingCountForTest()).toBe(3); // capped; 2 oldest dropped
      expect(spy.mock.calls.some(c => String(c[0]).includes('AUDIT EVENTS DROPPED (2)'))).toBe(true);
    } finally {
      __setMaxPendingForTest(null);
      spy.mockRestore();
    }
  });
});
