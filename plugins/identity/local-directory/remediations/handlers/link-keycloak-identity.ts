/**
 * local-directory:link_keycloak_identity
 *
 * Drift remediation for Local Directory identities whose Keycloak user is
 * missing/unlinked. Enqueues `iam_provision_app_user` (the canonical LD →
 * Keycloak provisioner, keyed on local_directory_users.id) rather than
 * calling Keycloak inline — every Keycloak Admin call goes through a Bull
 * job, and the drift detector must not block on a provider HTTP call while
 * scanning agencies. Idempotent: already-linked users are a no-op.
 */

import { publishAuditEvent } from '../../../../../lib/audit/publisher.js';
import { getRuntime } from '../../../../../lib/runtime.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
  RemediationActionHandler,
} from '../../../common/remediation-contract.js';

export const linkKeycloakIdentityHandler: RemediationActionHandler = async (
  _params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> => {
  const { prisma, enqueueJob, logger } = getRuntime();
  const trigger = (context.trigger || {}) as Record<string, unknown>;
  const principalId =
    (trigger.principalId as string | undefined) ||
    ((context as { principalId?: string }).principalId as string | undefined);

  if (!principalId) {
    throw new Error('link_keycloak_identity: missing principalId');
  }

  const user = await prisma.local_directory_users.findFirst({
    where: { id: principalId, agency_id: instance.agency_id },
    select: { id: true, email: true, display_name: true, keycloak_user_id: true, agency_id: true },
  });
  if (!user) {
    throw new Error(`link_keycloak_identity: user ${principalId} not found`);
  }

  // Already linked → idempotent no-op. No job, no provider call.
  if (user.keycloak_user_id) {
    return {
      actionCompleted: true,
      actionType: 'local-directory:link_keycloak_identity',
      executedAt: new Date().toISOString(),
      taskParams: { outcome: 'already_linked', keycloakUserId: user.keycloak_user_id },
    };
  }

  if (!enqueueJob) {
    throw new Error('local-directory:link_keycloak_identity: host did not provide enqueueJob');
  }

  const jobId = await enqueueJob('iam_provision_app_user', {
    tenantId: instance.agency_id,
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
  });

  // A null jobId means the enqueue silently no-op'd (catalog miss / queue
  // missing / Redis down). Surface it as a step failure rather than recording
  // success with no downstream effect — mirrors the GWS recreate handler (#985).
  if (!jobId) {
    logger.error(
      'link_keycloak_identity: enqueueJob(iam_provision_app_user) returned null — workflow cannot complete',
      { tenantId: instance.agency_id, principalId, userId: user.id, action: 'local-directory:link_keycloak_identity' },
    );
    throw new Error(
      'local-directory:link_keycloak_identity: enqueueJob(iam_provision_app_user) returned null — see worker logs for the catalog/queue lookup that failed',
    );
  }

  publishAuditEvent({
    eventType: 'remediation.link_keycloak_identity.enqueued',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'local-directory-user', id: user.id },
    context: { workflowInstanceId: instance.id, jobId },
  }).catch(() => {});

  return {
    actionCompleted: true,
    actionType: 'local-directory:link_keycloak_identity',
    executedAt: new Date().toISOString(),
    taskParams: { outcome: 'provision_enqueued', jobId },
  };
};
