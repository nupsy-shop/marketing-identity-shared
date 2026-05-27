/**
 * Retention sweep — per-agency unit tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findMany: vi.fn(),
  queryRaw: vi.fn(),
  executeRaw: vi.fn(),
  publishAuditEvent: vi.fn().mockResolvedValue({ eventId: 'e1' }),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('../../../lib/runtime.js', () => ({
  getRuntime: () => ({
    prisma: {
      agency_settings: { findUnique: mocks.findUnique, findMany: mocks.findMany },
      $queryRawUnsafe: mocks.queryRaw,
      $executeRawUnsafe: mocks.executeRaw,
    },
    logger: {
      info: mocks.loggerInfo,
      warn: vi.fn(),
      error: mocks.loggerError,
      debug: vi.fn(),
    },
  }),
}));

vi.mock('../../../lib/audit/publisher.js', () => ({
  publishAuditEvent: mocks.publishAuditEvent,
}));

import retentionSweep, { sweepAgency } from './retention-sweep.js';

const AGENCY = '00000000-0000-0000-0000-0000000000aa';
const fakeJob = (data: Record<string, unknown> = {}) => ({ id: 'job-1', data } as never);

beforeEach(() => {
  mocks.findUnique.mockReset();
  mocks.findMany.mockReset();
  mocks.queryRaw.mockReset();
  mocks.executeRaw.mockReset();
  mocks.publishAuditEvent.mockClear();
});

describe('sweepAgency', () => {
  it('skips when audit_legal_hold = true', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 90,
      audit_legal_hold: true,
      audit_sensitive_extended: false,
    });
    const r = await sweepAgency(AGENCY, false);
    expect(r.skipped).toBe('legal_hold');
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.publishAuditEvent).not.toHaveBeenCalled();
  });

  it('skips when retention_days < 0 (forever)', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: -1,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    const r = await sweepAgency(AGENCY, false);
    expect(r.skipped).toBe('forever');
    expect(mocks.executeRaw).not.toHaveBeenCalled();
  });

  it('skips when settings row is missing', async () => {
    mocks.findUnique.mockResolvedValue(null);
    const r = await sweepAgency(AGENCY, false);
    expect(r.skipped).toBe('no_settings');
  });

  it('deletes rows older than cutoff when no sensitive_extended', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 90,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    mocks.executeRaw.mockResolvedValue(7);
    const r = await sweepAgency(AGENCY, false);
    expect(r.deletedRows).toBe(7);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
    const [sql, agencyArg, cutoffArg] = mocks.executeRaw.mock.calls[0];
    expect(sql).toContain('DELETE FROM audit_events');
    expect(sql).not.toContain('event_type LIKE');
    expect(agencyArg).toBe(AGENCY);
    expect(cutoffArg).toBeInstanceOf(Date);
    expect(mocks.publishAuditEvent).toHaveBeenCalledTimes(1);
    const ev = mocks.publishAuditEvent.mock.calls[0][0];
    expect(ev.eventType).toBe('siem.retention.swept');
    expect(ev.context.deletedRows).toBe(7);
  });

  it('builds sensitive-exclusion clause when audit_sensitive_extended=true', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 30,
      audit_legal_hold: false,
      audit_sensitive_extended: true,
    });
    mocks.executeRaw.mockResolvedValue(3);
    await sweepAgency(AGENCY, false);
    const call = mocks.executeRaw.mock.calls[0];
    const [sql, , , ...patterns] = call;
    expect(sql).toContain('NOT (');
    expect(sql).toContain('event_type LIKE');
    expect(patterns).toEqual(expect.arrayContaining(['credential.%', 'policy.%', 'siem.legal_hold.%', 'identity.deleted']));
  });

  it('dryRun mode uses SELECT COUNT and does not delete', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 90,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    mocks.queryRaw.mockResolvedValue([{ c: 12n }]);
    const r = await sweepAgency(AGENCY, true);
    expect(r.deletedRows).toBe(12);
    expect(r.dryRun).toBe(true);
    expect(mocks.executeRaw).not.toHaveBeenCalled();
    expect(mocks.queryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw.mock.calls[0][0]).toContain('SELECT COUNT(*)');
  });

  it('does NOT fail the sweep when the publishAuditEvent rejects', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 90,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    mocks.executeRaw.mockResolvedValue(0);
    mocks.publishAuditEvent.mockRejectedValueOnce(new Error('publish broken'));
    const r = await sweepAgency(AGENCY, false);
    expect(r.deletedRows).toBe(0);
  });
});

describe('retentionSweep job', () => {
  it('iterates all agencies when agencyId not specified', async () => {
    mocks.findMany.mockResolvedValue([
      { agency_id: 'ag-1' }, { agency_id: 'ag-2' },
    ]);
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 30,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    mocks.executeRaw.mockResolvedValue(1);
    const out = await retentionSweep(fakeJob({}));
    expect(out.agenciesProcessed).toBe(2);
    expect(out.totalDeleted).toBe(2);
  });

  it('runs for only the agency in job.data when provided', async () => {
    mocks.findUnique.mockResolvedValue({
      audit_retention_days: 30,
      audit_legal_hold: false,
      audit_sensitive_extended: false,
    });
    mocks.executeRaw.mockResolvedValue(5);
    const out = await retentionSweep(fakeJob({ agencyId: AGENCY }));
    expect(out.agenciesProcessed).toBe(1);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it('agency failures are recorded but do not abort the run', async () => {
    mocks.findMany.mockResolvedValue([
      { agency_id: 'ag-1' }, { agency_id: 'ag-2' },
    ]);
    mocks.findUnique
      .mockResolvedValueOnce({
        audit_retention_days: 30, audit_legal_hold: false, audit_sensitive_extended: false,
      })
      .mockRejectedValueOnce(new Error('boom'));
    mocks.executeRaw.mockResolvedValue(1);
    const out = await retentionSweep(fakeJob({}));
    expect(out.agenciesProcessed).toBe(2);
    expect(mocks.loggerError).toHaveBeenCalled();
  });
});
