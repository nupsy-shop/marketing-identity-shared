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

export interface ReconcileResult {
  reconciled: boolean;
  finalStatus: 'PROVISIONED' | 'ERROR' | 'PENDING';
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
    return { reconciled: false, finalStatus: 'PENDING' };
  }

  // Already in a terminal state — nothing to do
  if (identity.provisioning_status === 'PROVISIONED') {
    return { reconciled: false, finalStatus: 'PROVISIONED' };
  }

  const providerStatus = (identity.provisioning_providers_status || {}) as Record<
    string,
    { status: string }
  >;
  const statuses = Object.values(providerStatus);

  if (statuses.length === 0) {
    return { reconciled: false, finalStatus: 'PENDING' };
  }

  const anyPending = statuses.some((p) => p.status === 'PENDING');
  const anyError = statuses.some((p) => p.status === 'ERROR');
  const allDone = statuses.every(
    (p) => p.status === 'PROVISIONED' || p.status === 'SKIPPED',
  );

  if (allDone) {
    // Atomic update: only transition if not already PROVISIONED
    const updated = await prisma.integration_identities.updateMany({
      where: {
        id: identityId,
        provisioning_status: { not: 'PROVISIONED' },
      },
      data: {
        provisioning_status: 'PROVISIONED',
        provisioned_at: new Date(),
        updatedAt: new Date(),
      },
    });
    return { reconciled: updated.count > 0, finalStatus: 'PROVISIONED' };
  }

  if (anyError && !anyPending) {
    // All providers are done but at least one errored
    await prisma.integration_identities.updateMany({
      where: {
        id: identityId,
        provisioning_status: { notIn: ['PROVISIONED', 'ERROR'] },
      },
      data: {
        provisioning_status: 'ERROR',
        updatedAt: new Date(),
      },
    });
    return { reconciled: true, finalStatus: 'ERROR' };
  }

  // Some still PENDING — do nothing, next processor will reconcile
  return { reconciled: false, finalStatus: 'PENDING' };
}
