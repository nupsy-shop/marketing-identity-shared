/**
 * Unit tests: job.failed audit emit on iam_upsert_realm_idp processor failure.
 *
 * Spec: marketing-identity docs/superpowers/specs/
 *       2026-05-27-bull-queue-audit-observation-design.md  (§3. Worker-side
 *       failure audit — verifyexisting)
 *
 * What this guards (@QaseID=660):
 *   The processor MUST emit a `job.failed` audit event in its catch block
 *   (after writing sso_last_error) with:
 *     - eventType: 'job.failed'
 *     - context.attemptsMade  ← from job.attemptsMade
 *     - context.isFinalAttempt ← true when attemptsMade + 1 >= opts.attempts
 *     - context.error         ← the same scrubbed message stored in sso_last_error
 *     - context.jobType: 'iam_upsert_realm_idp'
 *     - severity: 'error' on final attempt, 'warning' on intermediate
 *
 *   The emit is fire-and-forget: a publisher hiccup MUST NOT suppress the
 *   rethrow so Bull's retry logic still kicks in.
 *
 * Test strategy:
 *   - Drive the processor into the "discovery_failed: .well-known returned 404"
 *     path via the resolveProviderOverride seam (same pattern as E2E BDD tests).
 *   - That path exercises the full catch block on every attempt — no special
 *     "final-only" logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRuntime, clearRuntime } from '../../runtime.js';

// ─── Hoisted mocks ───────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  publishAuditEvent: vi.fn().mockResolvedValue({ eventId: 'test-event-id' }),
  loggerInfo:  vi.fn(),
  loggerWarn:  vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('../../audit/publisher.js', () => ({
  publishAuditEvent: mocks.publishAuditEvent,
}));

// Keycloak admin functions — not relevant for the discovery-failure path.
vi.mock('../../keycloakAdmin.js', () => ({
  isKeycloakAdminConfigured: vi.fn().mockReturnValue(true),
  listRealmIdentityProviders: vi.fn().mockResolvedValue([]),
  getRealmIdentityProvider: vi.fn().mockResolvedValue(null),
  createRealmIdentityProvider: vi.fn().mockResolvedValue(undefined),
  updateRealmIdentityProvider: vi.fn().mockResolvedValue(undefined),
  deleteRealmIdentityProvider: vi.fn().mockResolvedValue(undefined),
  listIdentityProviderMappers: vi.fn().mockResolvedValue([]),
  createIdentityProviderMapper: vi.fn().mockResolvedValue(undefined),
}));

// Import SUT AFTER mocks are set.
const { default: iamUpsertRealmIdp } = await import('./iam-upsert-realm-idp.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AGENCY_ID = 'agency-test-sso';
const REALM     = 'realm-test';

/** Minimal agency_settings row with all SSO fields populated. */
const baseSettings = {
  agency_id:         AGENCY_ID,
  keycloak_realm:    REALM,
  sso_provider:      'okta',
  sso_client_id:     'client-123',
  sso_client_secret: 'secret-abc',
  sso_issuer_url:    'https://sso.example.com',
};

/**
 * Build a mock prisma instance.  The agency_settings.update path in the
 * catch block is best-effort (.catch(() => {})) — we still stub it so the
 * mock doesn't throw unexpectedly.
 */
function makePrisma(settingsOverrides: Partial<typeof baseSettings> = {}) {
  const settings = { ...baseSettings, ...settingsOverrides };
  return {
    agency_settings: {
      findUnique: vi.fn().mockResolvedValue(settings),
      update:     vi.fn().mockResolvedValue(settings),
    },
  };
}

/** Return a runtime wired with a provider-override that forces 404 on the
 *  .well-known discovery URL — deterministic "discovery_failed" trigger. */
function makeRuntime(prisma: ReturnType<typeof makePrisma>) {
  return {
    prisma,
    logger: {
      info:  mocks.loggerInfo,
      warn:  mocks.loggerWarn,
      error: mocks.loggerError,
      debug: mocks.loggerDebug,
    },
    resolveProviderOverride: vi.fn().mockResolvedValue({ status: 404, body: null }),
  };
}

/** Build a minimal BullMQ-shaped job object. */
function makeJob(attemptsMade: number, totalAttempts: number) {
  return {
    id:           `job-sso-${attemptsMade}`,
    data: {
      agencyId:        AGENCY_ID,
      desiredProvider: 'okta' as const,
      triggeredBy:     'test',
    },
    attemptsMade,
    opts: { attempts: totalAttempts },
  };
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockClear());
  mocks.publishAuditEvent.mockResolvedValue({ eventId: 'test-event-id' });
});

afterEach(() => {
  clearRuntime();
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('iam_upsert_realm_idp — job.failed audit emit (QaseID=660)', () => {
  it('emits job.failed with isFinalAttempt=true when this is the last attempt', async () => {
    // 5-attempt job; attemptsMade=4 means this IS the 5th (final) attempt.
    const job = makeJob(4, 5);
    const prisma = makePrisma();
    setRuntime(makeRuntime(prisma) as any);

    await expect(iamUpsertRealmIdp(job)).rejects.toThrow();

    // publishAuditEvent must have been called at least once with job.failed.
    const failedCalls = mocks.publishAuditEvent.mock.calls.filter(
      (c) => (c[0] as any).eventType === 'job.failed',
    );
    expect(failedCalls).toHaveLength(1);

    const payload = failedCalls[0][0] as any;
    expect(payload.context.attemptsMade).toBe(4);
    expect(payload.context.isFinalAttempt).toBe(true);
    expect(payload.context.jobType).toBe('iam_upsert_realm_idp');
    expect(payload.severity).toBe('error');
  });

  it('emits job.failed with isFinalAttempt=false on an intermediate attempt', async () => {
    // 5-attempt job; attemptsMade=1 means this is the 2nd attempt — not final.
    const job = makeJob(1, 5);
    const prisma = makePrisma();
    setRuntime(makeRuntime(prisma) as any);

    await expect(iamUpsertRealmIdp(job)).rejects.toThrow();

    const failedCalls = mocks.publishAuditEvent.mock.calls.filter(
      (c) => (c[0] as any).eventType === 'job.failed',
    );
    expect(failedCalls).toHaveLength(1);

    const payload = failedCalls[0][0] as any;
    expect(payload.context.attemptsMade).toBe(1);
    expect(payload.context.isFinalAttempt).toBe(false);
    expect(payload.severity).toBe('warning');
  });

  it('audit payload carries the same error message written to sso_last_error', async () => {
    const job = makeJob(4, 5);
    const prisma = makePrisma();
    setRuntime(makeRuntime(prisma) as any);

    await expect(iamUpsertRealmIdp(job)).rejects.toThrow();

    // Read what was written to sso_last_error.
    const updateCall = prisma.agency_settings.update.mock.calls[0];
    const persistedError: string = updateCall[0].data.sso_last_error;
    expect(persistedError).toBeTruthy();

    // The audit context.error must match the base scrubbed message (the
    // isFinalAttempt prefix is on the persisted field only; the audit carries
    // the raw scrubbed message so consumers can extract it consistently).
    const failedCall = mocks.publishAuditEvent.mock.calls.find(
      (c) => (c[0] as any).eventType === 'job.failed',
    );
    expect(failedCall).toBeDefined();
    const auditError: string = (failedCall![0] as any).context.error;
    // The persisted error is either the scrubbed message or prefixed with
    // "max_attempts_exceeded: <scrubbed>" on final attempt.
    // Either way it must contain the audit error substring.
    expect(persistedError).toContain(auditError);
  });

  it('processor still rethrows even when publishAuditEvent rejects (fire-and-forget)', async () => {
    const job = makeJob(4, 5);
    const prisma = makePrisma();
    setRuntime(makeRuntime(prisma) as any);

    // Make the publisher reject — must NOT suppress the processor rethrow.
    mocks.publishAuditEvent.mockRejectedValue(new Error('publisher unavailable'));

    await expect(iamUpsertRealmIdp(job)).rejects.toThrow();
    // Test passes as long as the processor still throws (doesn't swallow the error).
  });
});
