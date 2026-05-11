/**
 * entra-id:recreate_synthetic_identity
 *
 * Idempotent drift remediation for Entra ID synthetic identities (service
 * accounts, shared mailboxes, bots) whose directory object is missing.
 *
 * Mirrors the Google Workspace handler: guards the synthetic-type +
 * PROVISIONED no-op, then enqueues the Entra provisioning job via the
 * shared runtime's host-provided `enqueueJob` callback.
 *
 * Agency-scoped; Prisma only; no raw SQL; no hardcoded fallbacks.
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
    throw new Error('entra-id:recreate_synthetic_identity: missing principalId');
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
    throw new Error(`entra-id:recreate_synthetic_identity: identity ${principalId} not found`);
  }
  if (!SYNTHETIC_TYPES.has(identity.type)) {
    throw new Error(
      `entra-id:recreate_synthetic_identity: identity ${principalId} is not a synthetic type (got ${identity.type})`,
    );
  }

  const providersStatus = (identity.provisioning_providers_status || {}) as Record<string, { status?: string }>;
  const entraStatus = providersStatus['entra-id']?.status;
  if (entraStatus === 'PROVISIONED') {
    return {
      actionCompleted: true,
      actionType: 'entra-id:recreate_synthetic_identity',
      executedAt: new Date().toISOString(),
      taskParams: { outcome: 'already_provisioned', principalId },
    };
  }

  if (!enqueueJob) {
    throw new Error('entra-id:recreate_synthetic_identity: host did not provide enqueueJob');
  }
  const jobId = await enqueueJob('entra_create_user', {
    tenantId: instance.agency_id,
    triggeredBy: 'drift-remediation',
    identityId: identity.id,
    email: identity.identifier,
    displayName: identity.name || identity.identifier,
    platformKey: identity.platform_key,
  });

  // Mirror of the GWS check (#985): silent unenqueued state would
  // have the workflow record actionCompleted=true while nothing
  // downstream ever ran. Surface the failure explicitly.
  if (!jobId) {
    const { logger } = getRuntime();
    logger.error(
      'recreate_synthetic_identity: enqueueJob(entra_create_user) returned null — workflow cannot complete',
      {
        tenantId: instance.agency_id,
        principalId,
        identityId: identity.id,
        action: 'entra-id:recreate_synthetic_identity',
      },
    );
    throw new Error(
      'entra-id:recreate_synthetic_identity: enqueueJob(entra_create_user) returned null — see worker logs for the catalog/queue lookup that failed',
    );
  }

  return {
    actionCompleted: true,
    actionType: 'entra-id:recreate_synthetic_identity',
    executedAt: new Date().toISOString(),
    taskParams: { outcome: 'provision_enqueued', principalId, jobId },
  };
};
