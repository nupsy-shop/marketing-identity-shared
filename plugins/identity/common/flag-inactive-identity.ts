/**
 * Shared util: flag a HUMAN_INTERACTIVE identity as inactive in a provider.
 *
 * Used by both `google-workspace:flag_inactive_identity` and
 * `entra-id:flag_inactive_identity`. Plugin handlers are thin wrappers that
 * pass their `providerKey` and delegate entirely to this function.
 *
 * What this does:
 *   1. Reads the `integration_identities` row by principalId (agency-scoped).
 *   2. Updates `provisioning_status = 'inactive'` and sets
 *      `provisioning_providers_status[providerKey].status = 'INACTIVE'` with
 *      a timestamp, while preserving all other provider entries.
 *   3. Publishes an `identity.flagged_inactive` audit event.
 *   4. Dispatches an in-app notification to agency admins for manual review.
 *   5. Returns { status: 'flagged', identityId, providerKey }.
 *
 * Does NOT auto-revoke grants. Does NOT delete the identity row.
 * Manual admin review required — this is a flagging action only.
 *
 * Agency-scoped; Prisma only; no raw SQL; no hardcoded fallbacks.
 */

import { getRuntime } from '../../../lib/runtime.js';
import { publishAuditEvent } from '../../../lib/audit/publisher.js';
import { dispatchNotification } from '../../../lib/notifications/dispatch.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
} from './remediation-contract.js';

export async function flagInactiveIdentity(
  providerKey: 'google-workspace' | 'entra-id',
  _params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> {
  const { prisma } = getRuntime();

  const principalId = (context as { principalId?: string }).principalId;

  if (!principalId) {
    throw new Error(`${providerKey}:flag_inactive_identity: missing principalId`);
  }

  const identity = await prisma.integration_identities.findFirst({
    where: { id: principalId, agency_id: instance.agency_id },
    select: {
      id: true,
      identifier: true,
      type: true,
      provisioning_status: true,
      provisioning_providers_status: true,
    },
  });

  if (!identity) {
    throw new Error(
      `${providerKey}:flag_inactive_identity: identity ${principalId} not found`,
    );
  }

  // Merge-update: preserve all other provider entries, only set ours to INACTIVE.
  const existingStatus =
    (identity.provisioning_providers_status as Record<
      string,
      { status?: string; [k: string]: unknown }
    > | null) ?? {};

  const updatedProvidersStatus = {
    ...existingStatus,
    [providerKey]: {
      ...existingStatus[providerKey],
      status: 'INACTIVE',
      flaggedAt: new Date().toISOString(),
    },
  };

  await prisma.integration_identities.update({
    where: { id: identity.id },
    data: {
      provisioning_status: 'inactive',
      provisioning_providers_status: updatedProvidersStatus,
      updatedAt: new Date(),
    },
  });

  // Audit event — fire-and-forget; errors must not fail the action step.
  publishAuditEvent({
    eventType: 'identity.flagged_inactive',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'integration-identity', id: identity.id },
    context: {
      identityId: identity.id,
      identifier: identity.identifier,
      providerKey,
      workflowInstanceId: instance.id,
    },
  }).catch(() => {});

  // In-app notification to admins for manual review.
  dispatchNotification(instance.agency_id, 'identity.flagged_inactive', {
    identityId: identity.id,
    identifier: identity.identifier,
    providerKey,
    title: 'Identity flagged as inactive',
    body: `Identity ${identity.identifier} is admin-disabled in ${providerKey}. Manual review required.`,
    severity: 'warning',
  }).catch(() => {});

  return {
    actionCompleted: true,
    actionType: `${providerKey}:flag_inactive_identity`,
    executedAt: new Date().toISOString(),
    taskParams: {
      status: 'flagged',
      identityId: identity.id,
      providerKey,
    },
  };
}
