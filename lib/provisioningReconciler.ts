/**
 * Provisioning Status Reconciler
 *
 * Called by each processor after updating its own provider status.
 * Checks if all required providers are terminal (PROVISIONED or SKIPPED).
 * If so, marks the identity as PROVISIONED. If any are ERROR, marks ERROR.
 * If some are still PENDING, does nothing — the next processor to finish
 * will call reconcile again.
 *
 * Uses atomic WHERE guard to prevent race conditions when two processors
 * finish near-simultaneously.
 */

import {
  ProviderStatus,
  IdentityProvisioningStatus,
  isTerminalProviderStatus,
  type ProvidersStatusMap,
} from './provisioning-types';

export interface ReconcileResult {
  reconciled: boolean;
  finalStatus: IdentityProvisioningStatus;
}

/**
 * Reconcile provisioning status for an identity.
 *
 * @param prisma - Prisma client instance (passed in to avoid import coupling)
 * @param identityId - The integration_identities row ID
 * @returns Whether the identity was transitioned to a final status
 */
export async function reconcileProvisioningStatus(
  prisma: any,
  identityId: string,
): Promise<ReconcileResult> {
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
    select: {
      provisioning_status: true,
      provisioning_providers_status: true,
    },
  });

  if (!identity) {
    return { reconciled: false, finalStatus: IdentityProvisioningStatus.PENDING };
  }

  // Already in a terminal state — nothing to do
  if (identity.provisioning_status === IdentityProvisioningStatus.PROVISIONED) {
    return { reconciled: false, finalStatus: IdentityProvisioningStatus.PROVISIONED };
  }

  const providerStatus = (identity.provisioning_providers_status || {}) as unknown as ProvidersStatusMap;
  const statuses = Object.values(providerStatus);

  if (statuses.length === 0) {
    return { reconciled: false, finalStatus: IdentityProvisioningStatus.PENDING };
  }

  const anyPending = statuses.some((p) => p.status === ProviderStatus.PENDING);
  const anyError = statuses.some((p) => p.status === ProviderStatus.ERROR);
  const allDone = statuses.every((p) => isTerminalProviderStatus(p.status));

  if (allDone) {
    // Atomic update: only transition if not already PROVISIONED
    const updated = await prisma.integration_identities.updateMany({
      where: {
        id: identityId,
        provisioning_status: { not: IdentityProvisioningStatus.PROVISIONED },
      },
      data: {
        provisioning_status: IdentityProvisioningStatus.PROVISIONED,
        provisioned_at: new Date(),
        updatedAt: new Date(),
      },
    });
    return { reconciled: updated.count > 0, finalStatus: IdentityProvisioningStatus.PROVISIONED };
  }

  if (anyError && !anyPending) {
    // All providers are done but at least one errored
    await prisma.integration_identities.updateMany({
      where: {
        id: identityId,
        provisioning_status: { notIn: [IdentityProvisioningStatus.PROVISIONED, IdentityProvisioningStatus.ERROR] },
      },
      data: {
        provisioning_status: IdentityProvisioningStatus.ERROR,
        updatedAt: new Date(),
      },
    });
    return { reconciled: true, finalStatus: IdentityProvisioningStatus.ERROR };
  }

  // Some still PENDING — do nothing, next processor will reconcile
  return { reconciled: false, finalStatus: IdentityProvisioningStatus.PENDING };
}
