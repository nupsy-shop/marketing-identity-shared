/**
 * gws_create_user — null-tenant guard test.
 *
 * Regression for bull #361 jobs 10702/10704: a gws_create_user job enqueued
 * with tenantId:null made identity_sources.findFirst({ agency_id: null }) throw
 * "Argument agency_id must not be null", failing the job opaquely. The enqueue
 * side is now guarded, but the processor must also treat a malformed/replayed
 * null-tenant job as a clean ERROR rather than a hard throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { setRuntime, clearRuntime } from '../../../../lib/runtime.js';
import { ProviderStatus } from '../../../../lib/provisioning-types.js';

// Audit publisher is not exercised by the guard path, but the module is
// imported by the processor — stub it so no real transport is constructed.
vi.mock('../../../../lib/audit/publisher.js', () => ({
  publishAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

const { default: gwsCreateUser } = await import('./gws-create-user.js');

function makePrisma() {
  return {
    integration_identities: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'ident-001',
        provisioning_status: 'PENDING',
        provisioning_providers_status: {},
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    identity_sources: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    oauth_tokens: { update: vi.fn().mockResolvedValue({}) },
  };
}

describe('gwsCreateUser — null tenantId guard', () => {
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    setRuntime({
      prisma,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
  });

  afterEach(() => {
    clearRuntime();
    vi.clearAllMocks();
  });

  for (const tenantId of [null, undefined]) {
    it(`marks ERROR without hitting identity_sources when tenantId is ${tenantId}`, async () => {
      const job = { id: 'job-1', data: { tenantId, identityId: 'ident-001' } } as any;

      const result = await gwsCreateUser(job);

      // Never reaches the null-rejecting findFirst.
      expect(prisma.identity_sources.findFirst).not.toHaveBeenCalled();

      // Records a clear provider-level ERROR on the identity.
      const errWrite = prisma.integration_identities.updateMany.mock.calls.find(
        ([arg]: [any]) =>
          arg?.data?.provisioning_providers_status?.['google-workspace']?.status ===
          ProviderStatus.ERROR,
      );
      expect(errWrite).toBeDefined();
      expect(
        String(errWrite![0].data.provisioning_providers_status['google-workspace'].reason),
      ).toMatch(/tenant/i);

      // Job completes cleanly rather than throwing.
      expect(result).toEqual({ status: 'completed', jobType: 'gws_create_user' });
    });
  }
});
