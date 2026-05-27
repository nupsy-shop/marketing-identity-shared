/**
 * Body-strip on failure — publish-time redaction.
 *
 * Verifies that when `agency_settings.audit_masking.stripBodiesOnFailure`
 * is true and the event's `context.outcome === 'failure'`, the publisher
 * replaces `context.body` with '[stripped]' BEFORE canonicalization, so
 * the chain hash reflects the redacted bytes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  putAuditBody: vi.fn().mockResolvedValue(undefined),
  insertChainMany: vi.fn().mockResolvedValue(undefined),
  enqueueJob: vi.fn().mockResolvedValue('job-1'),
}));

vi.mock('@prisma/client', () => ({
  Prisma: { PrismaClientKnownRequestError: class {} },
}));

// The shared repo has no node_modules at install-time (the host provides
// deps). Mock the third-party canonicalize package with a deterministic
// JSON.stringify so we can substring-search the resulting bytes.
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
  __resetMaskingCacheForTest,
} from './publisher.js';

const AGENCY = '00000000-0000-0000-0000-000000000001';

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.putAuditBody.mockClear();
  mocks.insertChainMany.mockClear();
  __resetPublisherForTest();
  __resetMaskingCacheForTest();
});

function getPutBody(): string {
  const call = mocks.putAuditBody.mock.calls[0]?.[0] as { body: Buffer };
  return call.body.toString('utf8');
}

describe('publisher body-strip on failure', () => {
  it('replaces context.body with "[stripped]" when stripBodiesOnFailure=true AND outcome=failure', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_masking: { piiMode: 'exports', stripBodiesOnFailure: true, anonymizeAuditor: true },
    });
    await publishAuditEvent({
      eventType: 'platform.gws.user.suspend',
      agency: { id: AGENCY },
      actor: { id: 'system', type: 'system' },
      context: { outcome: 'failure', body: { suspendedUser: 'alice@example.com', reason: 'JML' } },
    });
    await flushAll();
    expect(mocks.putAuditBody).toHaveBeenCalledTimes(1);
    const body = getPutBody();
    expect(body).toContain('"body":"[stripped]"');
    expect(body).not.toContain('alice@example.com');
  });

  it('leaves body untouched on outcome=success even when stripBodiesOnFailure=true', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_masking: { piiMode: 'exports', stripBodiesOnFailure: true, anonymizeAuditor: true },
    });
    await publishAuditEvent({
      eventType: 'platform.gws.user.suspend',
      agency: { id: AGENCY },
      actor: { id: 'system', type: 'system' },
      context: { outcome: 'success', body: { suspendedUser: 'alice@example.com' } },
    });
    await flushAll();
    expect(getPutBody()).toContain('alice@example.com');
  });

  it('leaves body untouched on outcome=failure when stripBodiesOnFailure=false', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_masking: { piiMode: 'exports', stripBodiesOnFailure: false, anonymizeAuditor: true },
    });
    await publishAuditEvent({
      eventType: 'platform.gws.user.suspend',
      agency: { id: AGENCY },
      actor: { id: 'system', type: 'system' },
      context: { outcome: 'failure', body: { suspendedUser: 'alice@example.com' } },
    });
    await flushAll();
    expect(getPutBody()).toContain('alice@example.com');
  });

  it('handles event without context.body (no-op)', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_masking: { piiMode: 'exports', stripBodiesOnFailure: true, anonymizeAuditor: true },
    });
    await publishAuditEvent({
      eventType: 'platform.gws.user.suspend',
      agency: { id: AGENCY },
      actor: { id: 'system', type: 'system' },
      context: { outcome: 'failure', error: 'rate_limited' },
    });
    await flushAll();
    expect(getPutBody()).toContain('"outcome":"failure"');
    expect(getPutBody()).not.toContain('"body"');
  });

  it('caches settings — 2 publishes for same agency hit the DB once', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_masking: { stripBodiesOnFailure: true },
    });
    await publishAuditEvent({
      eventType: 'x.y', agency: { id: AGENCY }, actor: { id: 's', type: 'system' },
      context: { outcome: 'failure', body: { a: 1 } },
    });
    await publishAuditEvent({
      eventType: 'x.y', agency: { id: AGENCY }, actor: { id: 's', type: 'system' },
      context: { outcome: 'failure', body: { a: 2 } },
    });
    await flushAll();
    expect(mocks.findUnique).toHaveBeenCalledTimes(1);
  });

  it('does not strip when masking row is missing (defaults to false)', async () => {
    mocks.findUnique.mockResolvedValue(null);
    await publishAuditEvent({
      eventType: 'x.y', agency: { id: AGENCY }, actor: { id: 's', type: 'system' },
      context: { outcome: 'failure', body: { secret: 'top' } },
    });
    await flushAll();
    expect(getPutBody()).toContain('"secret":"top"');
  });

  it('does not strip when DB lookup throws (fail-open to non-strip)', async () => {
    mocks.findUnique.mockRejectedValue(new Error('db down'));
    await publishAuditEvent({
      eventType: 'x.y', agency: { id: AGENCY }, actor: { id: 's', type: 'system' },
      context: { outcome: 'failure', body: { secret: 'top' } },
    });
    await flushAll();
    expect(getPutBody()).toContain('"secret":"top"');
  });
});
