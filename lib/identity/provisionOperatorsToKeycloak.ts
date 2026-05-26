/**
 * Enqueue Keycloak provisioning for every operator user in an agency.
 *
 * Called by manual "Fix All" remediation and by GWS / Entra-ID OAuth callback
 * handlers so reconnect closes the operator-drift gap automatically.
 *
 * Idempotency: the worker handler (`iam_provision_identity`) checks
 * findKeycloakUserByEmail before creating, so re-enqueueing existing
 * operators is a no-op.
 */
import prisma from '@/lib/db/prisma';
import { enqueue } from '@/lib/jobs/enqueue';

export type ProvisionOperatorsResult = { enqueued: number; operators: number };

export async function enqueueOperatorProvisioning(args: {
  agencyId: string;
  realm: string;
  triggeredBy: string;
}): Promise<ProvisionOperatorsResult> {
  const { agencyId, realm, triggeredBy } = args;

  const [adminUsers, teamMembers] = await Promise.all([
    prisma.users.findMany({
      where: {
        agency_id: agencyId,
        is_active: true,
        role: { in: ['agency_owner', 'agency_admin', 'ops_admin'] },
      },
      select: { id: true, email: true, name: true },
    }),
    prisma.client_role_assignments.findMany({
      where: { agency_id: agencyId, is_active: true, role: 'client_team_member' },
      select: { app_user_id: true },
    }),
  ]);

  const adminIds = new Set(adminUsers.map(u => u.id));
  const extraTeamIds = teamMembers
    .map(m => m.app_user_id)
    .filter(id => !adminIds.has(id));

  const teamUsers = extraTeamIds.length
    ? await prisma.users.findMany({
        where: { id: { in: extraTeamIds }, agency_id: agencyId, is_active: true },
        select: { id: true, email: true, name: true },
      })
    : [];

  const operators = [...adminUsers, ...teamUsers];

  let enqueued = 0;
  for (const op of operators) {
    const parts = (op.name ?? '').trim().split(/\s+/);
    const firstName = parts[0] || op.email.split('@')[0];
    const lastName = parts.slice(1).join(' ') || 'User';

    const jobId = await enqueue(
      'iam_provision_identity',
      {
        tenantId: agencyId,
        triggeredBy,
        realm,
        email: op.email,
        firstName,
        lastName,
      },
      { priority: 1, attempts: 5 },
    );
    if (jobId) enqueued++;
  }

  return { enqueued, operators: operators.length };
}
