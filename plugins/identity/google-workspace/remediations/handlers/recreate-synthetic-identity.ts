/**
 * google-workspace:recreate_synthetic_identity
 *
 * Idempotent drift remediation for Google Workspace synthetic identities
 * (service accounts, shared inboxes, bots) whose directory user is missing.
 *
 * Behavior:
 *   - identity not found (wrong id, deleted) → step fails
 *   - identity not a synthetic type             → step fails
 *   - provider status already PROVISIONED       → no-op success
 *   - otherwise → enqueue `gws_create_user` through the shared runtime's
 *     host-provided `enqueueJob` hook. The existing GWS provision
 *     processor (`gws-create-user.ts`) does the API work, refreshes the
 *     OAuth token if needed, and reconciles provisioning status.
 *
 * Agency-scoped: `integration_identities` is queried with
 * `agency_id = instance.agency_id`. No raw SQL. No hardcoded fallbacks.
 */

import { getRuntime } from '../../../../../lib/runtime.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
  RemediationActionHandler,
} from '../../../common/remediation-contract.js';

const SYNTHETIC_TYPES = new Set([
  'SERVICE_ACCOUNT',
  'SHARED_CREDENTIAL',
  'API_KEY',
  'OAUTH_CLIENT',
]);

export const recreateSyntheticIdentityHandler: RemediationActionHandler = async (
  _params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> => {
  const { prisma, enqueueJob } = getRuntime();
  const trigger = (context.trigger || {}) as Record<string, unknown>;
  const principalId =
    (trigger.principalId as string | undefined) ||
    ((context as { principalId?: string }).principalId as string | undefined);
  if (!principalId) {
    throw new Error('google-workspace:recreate_synthetic_identity: missing principalId');
  }

  const identity = await prisma.integration_identities.findFirst({
    where: { id: principalId, agency_id: instance.agency_id },
    select: {
      id: true,
      type: true,
      identifier: true,
      name: true,
      platform_key: true,
      provisioning_status: true,
      provisioning_providers_status: true,
    },
  });
  if (!identity) {
    throw new Error(`google-workspace:recreate_synthetic_identity: identity ${principalId} not found`);
  }
  if (!SYNTHETIC_TYPES.has(identity.type)) {
    throw new Error(
      `google-workspace:recreate_synthetic_identity: identity ${principalId} is not a synthetic type (got ${identity.type})`,
    );
  }

  const providersStatus = (identity.provisioning_providers_status || {}) as Record<string, { status?: string }>;
  const gwsStatus = providersStatus['google-workspace']?.status;
  if (gwsStatus === 'PROVISIONED') {
    return {
      actionCompleted: true,
      actionType: 'google-workspace:recreate_synthetic_identity',
      executedAt: new Date().toISOString(),
      taskParams: { outcome: 'already_provisioned', principalId },
    };
  }

  if (!enqueueJob) {
    throw new Error('google-workspace:recreate_synthetic_identity: host did not provide enqueueJob');
  }
  const jobId = await enqueueJob('gws_create_user', {
    tenantId: instance.agency_id,
    triggeredBy: 'drift-remediation',
    identityId: identity.id,
    email: identity.identifier,
    displayName: identity.name || identity.identifier,
    platformKey: identity.platform_key,
  });

  // Treat a null jobId as a hard failure — silent unenqueued state
  // was the bug behind #985. enqueueJob returns null when:
  //   - the job type isn't in the shared catalog (queueForUnsafe miss)
  //   - the host's queue instance for the target queue is missing
  //   - the catalog-routed queue's `add()` rejects (Redis down)
  // In every case the workflow should surface the failure rather than
  // record actionCompleted=true with no downstream effect.
  if (!jobId) {
    const { logger } = getRuntime();
    logger.error(
      'recreate_synthetic_identity: enqueueJob(gws_create_user) returned null — workflow cannot complete',
      {
        tenantId: instance.agency_id,
        principalId,
        identityId: identity.id,
        action: 'google-workspace:recreate_synthetic_identity',
      },
    );
    throw new Error(
      'google-workspace:recreate_synthetic_identity: enqueueJob(gws_create_user) returned null — see worker logs for the catalog/queue lookup that failed',
    );
  }

  return {
    actionCompleted: true,
    actionType: 'google-workspace:recreate_synthetic_identity',
    executedAt: new Date().toISOString(),
    taskParams: { outcome: 'provision_enqueued', principalId, jobId },
  };
};
