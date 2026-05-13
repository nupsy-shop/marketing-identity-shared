/**
 * IAM Teardown Identity — retry handler for soft-deleted identities
 *
 * Drains the `iam_teardown_identity` Bull queue populated by the web-side
 * DELETE route (marketing-identity#1047 / parent issue #1044). When the
 * happy-path DELETE could not tear down the upstream Keycloak user, the
 * route preserves the row with `status='failed_delete'` and enqueues
 * this job. This processor re-runs the teardown and — on success —
 * deletes the DB row.
 *
 * Payload (set by the web enqueuer):
 *   {
 *     tenantId:    string  — agency_id; every Prisma call is filtered by it
 *     identityId:  string  — integration_identities.id
 *     retryReason: string  — original error message, for audit context
 *   }
 *
 * Idempotency matrix (issue #42):
 *   - Row missing                      → NoOp success.
 *   - Row reverted to `status='active'`→ NoOp success (someone recovered it).
 *   - Row still `status='failed_delete'`→ run the teardown + DB delete.
 *
 * On success:
 *   1. Re-run the IdP teardown (inline of the parent app's
 *      `lib/identity/teardown.ts` helper; see the entra-disconnect
 *      processor for the established "inline web helpers so the
 *      processor is portable to the worker" pattern).
 *   2. Delete the DB row.
 *   3. Emit `identity.teardown.retried` (canonical mapping for the
 *      legacy `IDENTITY_TEARDOWN_RETRIED` constant).
 *   4. Emit `identity.deleted` (the canonical success event — same
 *      event-type as the happy-path web DELETE).
 *
 * On failure:
 *   - Row stays `failed_delete` (no status mutation).
 *   - Throws — Bull's default queue backoff (exponential, 5 attempts)
 *     retries; DLQ on exhaustion. The web-side "Retry delete" UI also
 *     remains available as an operator-driven recovery path.
 *
 * Keycloak 404 → idempotent success (the upstream user is already gone).
 *
 * Agency scoping: every Prisma read/write filters by `agency_id =
 * tenantId`. Per marketing-identity/memory/feedback_agency_scoping.md
 * — the worker's plugin processors enforce tenant scope via the WHERE
 * clause (the same pattern as iam-provision-identity, entra-disconnect).
 */

import type Bull from 'bull';
import { getRuntime } from '../../../../lib/runtime.js';
import { deleteKeycloakUser, isKeycloakAdminConfigured } from '../../../../lib/keycloakAdmin.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';

interface JobResult {
  status: 'completed' | 'skipped';
  jobType: 'iam_teardown_identity';
  reason?: string;
}

interface TeardownableIdentity {
  id: string;
  agency_id: string;
  keycloak_user_id: string | null;
  name?: string | null;
}

/**
 * Inline of the parent app's `teardownIdpForIdentity` helper. Duplicated
 * deliberately — the parent helper imports concrete app singletons
 * (`@/lib/db/prisma`, `@/lib/logger`) that don't exist on the worker.
 * See entra-disconnect for the established duplication pattern; a
 * follow-up issue will consolidate both copies into shared/.
 *
 * Resolves on success (including "nothing to tear down") and throws on
 * failure with a payload-safe message.
 */
async function teardownIdpForIdentity(identity: TeardownableIdentity): Promise<void> {
  const { prisma, logger } = getRuntime();

  if (!identity.keycloak_user_id) {
    logger.debug('iam_teardown_identity: no keycloak_user_id — skipping IdP teardown', {
      identityId: identity.id,
    });
    return;
  }

  // Realm comes from agency_settings (one row per agency). Tenant-scoped
  // by the WHERE clause. If the agency has no realm, there is nothing
  // upstream to tear down.
  const settings = await prisma.agency_settings.findFirst({
    where: { agency_id: identity.agency_id },
    select: { keycloak_realm: true },
  });
  const realm = settings?.keycloak_realm;
  if (!realm) {
    logger.debug('iam_teardown_identity: agency has no keycloak_realm — skipping IdP teardown', {
      identityId: identity.id,
      agencyId: identity.agency_id,
    });
    return;
  }

  try {
    await deleteKeycloakUser(realm, identity.keycloak_user_id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // Idempotency: 404 means the upstream user is already gone — treat
    // as success; the DB delete proceeds normally.
    if (/\b404\b/.test(message) || /not\s*found/i.test(message)) {
      logger.warn('iam_teardown_identity: keycloak user already gone — treating as success', {
        identityId: identity.id,
        keycloakUserId: identity.keycloak_user_id,
      });
      return;
    }
    throw new Error(`Keycloak user delete failed: ${message}`);
  }
}

export default async function iamTeardownIdentity(job: Bull.Job): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const { tenantId, identityId, retryReason } = job.data as {
    tenantId: string;
    identityId: string;
    retryReason?: string;
  };
  const jobId = String(job.id);

  if (!tenantId || !identityId) {
    // Defensive: a malformed payload should not retry forever. Treat as
    // skipped rather than throwing so Bull doesn't burn its attempt budget.
    logger.warn('iam_teardown_identity: missing tenantId or identityId — skipping', {
      jobId,
      tenantId,
      identityId,
    });
    return { status: 'skipped', jobType: 'iam_teardown_identity', reason: 'missing payload' };
  }

  // Agency-scoped read. findFirst+where{id,agency_id} keeps the tenant
  // boundary; never use findUnique without the agency filter.
  const identity = await prisma.integration_identities.findFirst({
    where: { id: identityId, agency_id: tenantId },
    select: {
      id: true,
      agency_id: true,
      keycloak_user_id: true,
      status: true,
      name: true,
    },
  });

  // Idempotency branch 1 — row missing (a prior retry already won).
  if (!identity) {
    logger.info('iam_teardown_identity: identity row missing — NoOp', { jobId, tenantId, identityId });
    return { status: 'skipped', jobType: 'iam_teardown_identity', reason: 'row missing' };
  }

  // Idempotency branch 2 — row reverted to active. The DELETE flow only
  // flips `status='failed_delete'`; if it's anything else (including the
  // canonical 'active'), someone else recovered it.
  if (identity.status !== 'failed_delete') {
    logger.info('iam_teardown_identity: identity no longer failed_delete — NoOp', {
      jobId, tenantId, identityId, currentStatus: identity.status,
    });
    return {
      status: 'skipped',
      jobType: 'iam_teardown_identity',
      reason: `status is '${identity.status}', not 'failed_delete'`,
    };
  }

  // Idempotency branch 3 — execute the retry.
  // Keycloak admin not configured? The web side wouldn't have produced
  // this job, but if a misconfigured worker dequeues it we treat the
  // teardown step as a no-op and still delete the DB row.
  if (!isKeycloakAdminConfigured()) {
    logger.warn('iam_teardown_identity: Keycloak admin not configured — skipping teardown step', {
      jobId, tenantId, identityId,
    });
  } else {
    await teardownIdpForIdentity({
      id: identity.id,
      agency_id: identity.agency_id,
      keycloak_user_id: identity.keycloak_user_id,
    });
  }

  // Success — remove the row. Agency-scoped via deleteMany+where.
  await prisma.integration_identities.deleteMany({
    where: { id: identityId, agency_id: tenantId },
  });

  // Emit the retry-specific audit first, then the canonical delete event,
  // so a downstream observer sees both the "retry succeeded" signal and
  // the standard "identity gone" signal. Both are fire-and-forget — the
  // teardown has already happened and we don't want a publisher hiccup
  // to fail the job.
  publishAuditEvent({
    eventType: 'identity.teardown.retried',
    source: 'accesshive',
    severity: 'info',
    actor: { id: null, type: 'system' },
    agency: { id: tenantId },
    resource: { type: 'identity', id: identityId, name: identity.name ?? undefined },
    context: {
      retryReason: retryReason ?? null,
      keycloakUserId: identity.keycloak_user_id,
      jobId,
      _legacyEvent: 'IDENTITY_TEARDOWN_RETRIED',
    },
  }).catch(() => {});

  publishAuditEvent({
    eventType: 'identity.deleted',
    source: 'accesshive',
    severity: 'info',
    actor: { id: null, type: 'system' },
    agency: { id: tenantId },
    resource: { type: 'identity', id: identityId, name: identity.name ?? undefined },
    context: { triggeredBy: 'iam_teardown_identity', jobId, _legacyEvent: 'IDENTITY_DELETED' },
  }).catch(() => {});

  logger.info('iam_teardown_identity: completed', { jobId, tenantId, identityId });
  return { status: 'completed', jobType: 'iam_teardown_identity' };
}
