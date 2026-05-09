/**
 * Shared util: flag a federation orphan detected in a provider's federated space.
 *
 * Used by both `google-workspace:flag_federation_orphan` and
 * `entra-id:flag_federation_orphan`. Plugin handlers are thin wrappers that
 * pass their `providerKey` and delegate entirely to this function.
 *
 * Design decision: Option B — flag-and-notify, no auto-create, no auto-revoke.
 * Orphans represent EITHER legitimate manual provisioning OR unauthorized access.
 * Auto-creating an identity record silently legitimizes unauthorized access —
 * security antipattern. Auto-revoking disrupts legitimate vendor/service accounts.
 * Admin must disposition each orphan manually.
 *
 * What this does:
 *   1. Reads principalId (= email) from context.
 *   2. Publishes an `identity.federation_orphan_detected` audit event.
 *   3. Dispatches an in-app notification to agency admins for manual review.
 *   4. Returns { status: 'flagged', email, providerKey }.
 *
 * Does NOT look up integration_identities — orphans have no identity row.
 * Does NOT auto-create an identity. Does NOT auto-revoke any grants.
 * Does NOT delete anything.
 *
 * Agency-scoped; Prisma only; no raw SQL; no hardcoded fallbacks.
 */

import { publishAuditEvent } from '../../../lib/audit/publisher.js';
import { dispatchNotification } from '../../../lib/notifications/dispatch.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
} from './remediation-contract.js';

export async function flagFederationOrphan(
  providerKey: 'google-workspace' | 'entra-id',
  _params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> {
  const principalId = (context as { principalId?: string }).principalId;

  if (!principalId) {
    throw new Error(`${providerKey}:flag_federation_orphan: missing principalId`);
  }

  const email = principalId; // principalId IS the email for orphans

  // Audit event — fire-and-forget; errors must not fail the action step.
  publishAuditEvent({
    eventType: 'identity.federation_orphan_detected',
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'federation-orphan', id: email },
    context: {
      email,
      providerKey,
      agencyId: instance.agency_id,
      workflowInstanceId: instance.id,
    },
  }).catch(() => {});

  // In-app notification to admins for manual review.
  dispatchNotification(instance.agency_id, 'identity.federation_orphan_detected', {
    email,
    providerKey,
    title: 'Federation orphan detected',
    body: `Provider user ${email} exists in the ${providerKey} federated space but has no AccessHive identity record. Admin disposition required.`,
    severity: 'warning',
  }).catch(() => {});

  return {
    actionCompleted: true,
    actionType: `${providerKey}:flag_federation_orphan`,
    executedAt: new Date().toISOString(),
    taskParams: {
      status: 'flagged',
      email,
      providerKey,
    },
  };
}
