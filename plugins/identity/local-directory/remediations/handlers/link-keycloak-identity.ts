/**
 * local-directory:link_keycloak_identity
 *
 * Idempotent drift remediation for Local Directory identities whose
 * Keycloak user is missing or unlinked. Moved from the central workflow
 * action dict (issue #90) into the Local Directory plugin as part of
 * issue #92 (plugin-owned remediation handlers).
 *
 * Behavior (unchanged from the central version):
 *   - already linked  → no-op
 *   - present + unlinked → link
 *   - missing         → create + link
 *
 * Runs under the agency scope of the workflow instance — every Prisma
 * query filters by `agency_id`.
 */

import {
  createKeycloakUser,
  findKeycloakUserByEmail,
} from '../../../../../lib/keycloakAdmin.js';
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
  const { prisma } = getRuntime();
  const trigger = (context.trigger || {}) as Record<string, unknown>;
  const principalId =
    (trigger.principalId as string | undefined) ||
    ((context as { principalId?: string }).principalId as string | undefined);

  if (!principalId) {
    throw new Error('link_keycloak_identity: missing principalId');
  }

  const user = await prisma.local_directory_users.findFirst({
    where: { id: principalId, agency_id: instance.agency_id },
    select: {
      id: true,
      email: true,
      display_name: true,
      keycloak_user_id: true,
      agency_id: true,
    },
  });
  if (!user) {
    throw new Error(`link_keycloak_identity: user ${principalId} not found`);
  }

  const agency = await prisma.agencies.findUnique({
    where: { id: user.agency_id },
    select: { slug: true },
  });
  const realm = `agency-${agency?.slug ?? ''}`;

  let outcome: 'linked_existing' | 'created_and_linked' | 'already_linked' =
    'already_linked';
  let keycloakUserId: string | null = user.keycloak_user_id ?? null;

  if (!keycloakUserId) {
    const existing = await findKeycloakUserByEmail(realm, user.email);
    const target =
      existing ??
      (await createKeycloakUser({
        realm,
        email: user.email,
        username: user.email,
        firstName: user.display_name,
        enabled: true,
        emailVerified: true,
      }));
    keycloakUserId = target.id ?? null;
    if (!keycloakUserId) {
      throw new Error('link_keycloak_identity: Keycloak user missing id');
    }
    await prisma.local_directory_users.update({
      where: { id: user.id },
      data: {
        keycloak_user_id: keycloakUserId,
        provisioned_at: new Date(),
        activation_status: 'provisioned',
        updated_at: new Date(),
      },
    });
    outcome = existing ? 'linked_existing' : 'created_and_linked';
  }

  publishAuditEvent({
    eventType: `remediation.link_keycloak_identity.${outcome}`,
    source: 'accesshive',
    actor: { id: 'system', type: 'system' },
    agency: { id: instance.agency_id },
    resource: { type: 'local-directory-user', id: user.id },
    context: {
      workflowInstanceId: instance.id,
      keycloakUserId,
      realm,
    },
  }).catch(() => {});

  return {
    actionCompleted: true,
    actionType: 'local-directory:link_keycloak_identity',
    executedAt: new Date().toISOString(),
    taskParams: { outcome, keycloakUserId },
  };
};
