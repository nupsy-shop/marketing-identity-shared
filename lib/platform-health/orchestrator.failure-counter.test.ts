// Unit test for the provider-auth failure-counter augmentation in the
// platform-health orchestrator.
//
// Closes the gap identified by the trevox GWS probe-miss RCA
// (docs/superpowers/specs/2026-05-25-trevox-gws-probe-miss-rca.md in the
// web repo): when the synthetic probe just succeeded but the user-call
// boundary recorded N+ per-request auth failures in the last window, the
// orchestrator must downgrade the result to `degraded` so the
// state-change + notification path fires.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Hoisted mocks (referenced inside vi.mock factories AND test bodies) ───

const mocks = vi.hoisted(() => {
  return {
    publishAuditEvent: vi.fn().mockResolvedValue(undefined),
    dispatchNotification: vi.fn().mockResolvedValue(undefined),
    fetchRecentTransitions: vi.fn().mockResolvedValue([]),
    findManyIdentitySources: vi.fn(),
    updateIdentitySource: vi.fn().mockResolvedValue(undefined),
    recordProviderAuthFailure: vi.fn().mockResolvedValue(undefined),
    getProviderAuthFailureCount: vi.fn().mockResolvedValue(0),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
  };
});

vi.mock('../audit/publisher.js', () => ({
  publishAuditEvent: mocks.publishAuditEvent,
}));
vi.mock('../notifications/dispatch.js', () => ({
  dispatchNotification: mocks.dispatchNotification,
}));
vi.mock('./es-query.js', () => ({
  fetchRecentTransitions: mocks.fetchRecentTransitions,
}));
vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    prisma: {
      identity_sources: {
        findMany: mocks.findManyIdentitySources,
        update: mocks.updateIdentitySource,
      },
    },
    logger: {
      info: mocks.loggerInfo,
      warn: mocks.loggerWarn,
      error: mocks.loggerError,
      debug: mocks.loggerDebug,
    },
    recordProviderAuthFailure: mocks.recordProviderAuthFailure,
    getProviderAuthFailureCount: mocks.getProviderAuthFailureCount,
  }),
}));

// Import SUT AFTER mocks are registered.
const { runHealthChecksForAgencyByPlugin } = await import('./orchestrator.js');
type LivenessFn = Parameters<typeof runHealthChecksForAgencyByPlugin>[0]['livenessFn'];
const {
  PROVIDER_AUTH_FAILURE_THRESHOLD,
  PROVIDER_AUTH_FAILURE_WINDOW_SECONDS,
} = await import('./types.js');

// ─── Fixtures ──────────────────────────────────────────────────────────────

const AGENCY = 'agency-trevox';
const NOW = new Date('2026-05-26T04:00:00Z');

const connectedSource = {
  id: 'src-gws-1',
  plugin_key: 'google-workspace',
  display_name: 'Google Workspace',
  connection_state: 'connected',
  connection_config: { customerId: 'C123', primaryDomain: 'trevox.agency' },
  last_sync_at: new Date('2026-05-26T03:50:00Z'),
  last_sync_status: 'success',
  last_sync_error: null,
  sync_interval_hours: 6,
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockClear());
  // Re-prime default impls cleared above.
  mocks.publishAuditEvent.mockResolvedValue(undefined);
  mocks.dispatchNotification.mockResolvedValue(undefined);
  mocks.fetchRecentTransitions.mockResolvedValue([]);
  mocks.updateIdentitySource.mockResolvedValue(undefined);
  mocks.recordProviderAuthFailure.mockResolvedValue(undefined);
});

describe('runHealthChecksForAgencyByPlugin — provider-auth failure-counter augmentation', () => {
  it('keeps `connected` when probe ok and failure count < threshold', async () => {
    mocks.findManyIdentitySources.mockResolvedValue([connectedSource]);
    const livenessFn: LivenessFn = async () => ({ ok: true, latencyMs: 42 });
    mocks.getProviderAuthFailureCount.mockResolvedValue(PROVIDER_AUTH_FAILURE_THRESHOLD - 1);

    const [result] = await runHealthChecksForAgencyByPlugin({
      agencyId: AGENCY,
      pluginKey: 'google-workspace',
      livenessFn,
      now: NOW,
    });

    expect(result.newState).toBe('connected');
    expect(result.transitioned).toBe(false);
    expect(mocks.getProviderAuthFailureCount).toHaveBeenCalledWith(
      AGENCY,
      'google-workspace',
      PROVIDER_AUTH_FAILURE_WINDOW_SECONDS,
    );
    const eventTypes = mocks.publishAuditEvent.mock.calls.map(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType,
    );
    expect(eventTypes).toEqual(['identity.source.health_check']);
    expect(mocks.dispatchNotification).not.toHaveBeenCalled();
  });

  it('downgrades to `degraded` when probe ok but failure count >= threshold', async () => {
    mocks.findManyIdentitySources.mockResolvedValue([connectedSource]);
    const livenessFn: LivenessFn = async () => ({ ok: true, latencyMs: 42 });
    mocks.getProviderAuthFailureCount.mockResolvedValue(PROVIDER_AUTH_FAILURE_THRESHOLD);

    const [result] = await runHealthChecksForAgencyByPlugin({
      agencyId: AGENCY,
      pluginKey: 'google-workspace',
      livenessFn,
      now: NOW,
    });

    expect(result.previousState).toBe('connected');
    expect(result.newState).toBe('degraded');
    expect(result.transitioned).toBe(true);

    const stateChange = mocks.publishAuditEvent.mock.calls.find(
      (c: unknown[]) => (c[0] as { eventType: string }).eventType === 'identity.source.state_change',
    );
    expect(stateChange).toBeDefined();
    expect(mocks.dispatchNotification).toHaveBeenCalledWith(
      AGENCY,
      'identity.source.degraded',
      expect.objectContaining({ pluginKey: 'google-workspace' }),
    );
  });

  it('does not consult the failure counter when the synthetic probe already failed', async () => {
    mocks.findManyIdentitySources.mockResolvedValue([connectedSource]);
    const livenessFn: LivenessFn = async () => ({
      ok: false,
      latencyMs: 50,
      errorCategory: 'server',
      errorMessage: 'HTTP 503',
    });

    await runHealthChecksForAgencyByPlugin({
      agencyId: AGENCY,
      pluginKey: 'google-workspace',
      livenessFn,
      now: NOW,
    });

    expect(mocks.getProviderAuthFailureCount).not.toHaveBeenCalled();
  });

  it('treats a counter-read error as non-fatal and trusts the synthetic probe', async () => {
    mocks.findManyIdentitySources.mockResolvedValue([connectedSource]);
    const livenessFn: LivenessFn = async () => ({ ok: true, latencyMs: 42 });
    mocks.getProviderAuthFailureCount.mockRejectedValueOnce(new Error('redis down'));

    const [result] = await runHealthChecksForAgencyByPlugin({
      agencyId: AGENCY,
      pluginKey: 'google-workspace',
      livenessFn,
      now: NOW,
    });

    expect(result.newState).toBe('connected');
    expect(result.transitioned).toBe(false);
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      'platform-health: failure-counter read failed (non-fatal)',
      expect.objectContaining({ err: 'redis down' }),
    );
  });
});
