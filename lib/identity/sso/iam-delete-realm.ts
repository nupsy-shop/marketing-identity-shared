/**
 * iam_delete_realm — agency-offboarding worker.
 *
 * Reads the realm pointer from SERVER-STATE (agency_settings.keycloak_realm)
 * for the given agencyId — the job payload's only authoritative field is
 * agencyId. This refuses arbitrary "delete this realm name" payloads.
 *
 * Hard safety net: a PROTECTED_REALMS set blocks deletion of shared/system
 * realms (agency-trevox, master) under any payload.
 *
 * Idempotent: a realm that's already gone (404) or a null pointer both
 * succeed; the call clears `keycloak_realm` and sets
 * `keycloak_realm_status='deleted'` on agency_settings either way.
 */
import { getRuntime } from '../../runtime.js';
import { deleteRealm, isKeycloakAdminConfigured } from '../../keycloakAdmin.js';

export interface DeleteRealmPayload {
  agencyId: string;
  triggeredBy?: string;
}

interface JobResult {
  status: 'completed' | 'failed' | 'skipped';
  jobType: 'iam_delete_realm';
  outcome?: 'deleted' | 'realm_absent' | 'skipped';
}

// Realms that may NEVER be deleted via this job under any circumstances.
// The shared E2E tenant + Keycloak's own master realm.
const PROTECTED_REALMS = new Set(['agency-trevox', 'master']);

export default async function iamDeleteRealm(job: { id?: unknown; data: DeleteRealmPayload }): Promise<JobResult> {
  const { prisma, logger } = getRuntime();
  const jobId = job.id;
  const { agencyId } = job.data;
  if (!agencyId) throw new Error('Missing required field: agencyId');

  const settings = await prisma.agency_settings.findUnique({
    where: { agency_id: agencyId },
  });
  const realm: string | null = (settings as { keycloak_realm?: string | null } | null)?.keycloak_realm ?? null;

  // No realm pointer — nothing to delete in Keycloak. Still normalise the row
  // (status='deleted') so the offboarding lifecycle reads consistently.
  if (!realm) {
    logger.info('iam_delete_realm: no realm pointer; nothing to delete in Keycloak', { jobId, agencyId });
    if (settings) {
      await prisma.agency_settings.update({
        where: { agency_id: agencyId },
        data: {
          keycloak_realm: null,
          keycloak_realm_status: 'deleted',
          keycloak_realm_provisioned_at: null,
        },
      }).catch(() => { /* best-effort */ });
    }
    return { status: 'completed', jobType: 'iam_delete_realm', outcome: 'realm_absent' };
  }

  // HARD GUARD: protected realms are never touched. The processor cannot be
  // coerced into deleting them by any payload because the realm name comes
  // from server-state, but we belt-and-suspenders this anyway.
  if (PROTECTED_REALMS.has(realm)) {
    throw new Error(`iam_delete_realm: refusing to delete protected realm "${realm}"`);
  }

  if (!isKeycloakAdminConfigured()) {
    logger.warn('iam_delete_realm: Keycloak admin not configured — skipping deletion', { jobId, agencyId, realm });
    return { status: 'completed', jobType: 'iam_delete_realm', outcome: 'skipped' };
  }

  await deleteRealm(realm, agencyId);
  await prisma.agency_settings.update({
    where: { agency_id: agencyId },
    data: {
      keycloak_realm: null,
      keycloak_realm_status: 'deleted',
      keycloak_realm_provisioned_at: null,
    },
  }).catch(() => { /* best-effort — the realm is gone either way */ });
  logger.info('iam_delete_realm: realm deleted', { jobId, agencyId, realm });
  return { status: 'completed', jobType: 'iam_delete_realm', outcome: 'deleted' };
}
