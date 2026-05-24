/**
 * Scheduled + cancel entry-points for remediations.
 *
 * Post-#93 the per-trigger dispatch logic (revoke / suspend / reprovision)
 * moved into the workflow engine's action step handlers — there is no
 * direct Prisma-mutation path here anymore. The previous `executeRemediation`
 * function that bypassed workflows has been deleted as part of unifying
 * execution on the workflow engine.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { loadPolicies } from './remediation-policies.js';
import { dispatchWorkflow } from './remediation-workflow.js';
import type {
  RemediationContext,
  RemediationPolicy,
  RemediationRecord,
  RemediationResult,
} from './remediation-types.js';

/**
 * Kick off any remediations that have been sitting in `scheduled` state
 * past their grace-period window. Each row routes through the workflow
 * engine via `dispatchWorkflow`.
 */
export async function executeScheduledRemediations(): Promise<RemediationResult[]> {
  const scheduled = await getRuntime().prisma.remediations.findMany({
    where: { status: 'scheduled', scheduled_at: { lte: new Date() } },
  });

  const results: RemediationResult[] = [];
  for (const row of scheduled) {
    const policies = await loadPolicies(row.agency_id);
    const policy = (policies[row.trigger_type] || {}) as RemediationPolicy;
    if (!policy.mode) policy.mode = 'fully_automatic';

    const dispatchResult = await dispatchWorkflow(
      row as unknown as RemediationRecord,
      policy,
      row.agency_id,
      row.trigger_type,
      (row.context || {}) as RemediationContext,
    );
    results.push(dispatchResult);
  }
  return results;
}

/**
 * Cancel a scheduled, pending, or awaiting-approval remediation. Also
 * cancels the associated workflow instance if one was started.
 */
export async function cancelRemediation(
  remediationId: string,
  actorId: string,
): Promise<{ success: boolean; error?: string; code?: string }> {
  const remediation = await getRuntime().prisma.remediations.findUnique({
    where: { id: remediationId },
  });

  if (!remediation) {
    return { success: false, error: 'Remediation not found', code: 'not_found' };
  }

  if (!['pending', 'scheduled', 'awaiting_approval', 'executing'].includes(remediation.status)) {
    return {
      success: false,
      error: `Cannot cancel remediation with status: ${remediation.status}`,
      code: 'cancel_invalid_state',
    };
  }

  await getRuntime().prisma.remediations.update({
    where: { id: remediationId },
    data: { status: 'cancelled', updated_at: new Date() },
  });

  if (remediation.workflow_instance_id) {
    try {
      const { cancelWorkflow } = await import('../workflows/engine.js');
      await cancelWorkflow(
        remediation.workflow_instance_id,
        'Remediation cancelled by admin',
      );
    } catch (err) {
      getRuntime().logger.warn(
        '[Remediation] Failed to cancel associated workflow:',
        { message: (err as Error).message },
      );
    }
  }

  publishAuditEvent({
    eventType: 'remediation.cancelled',
    action: 'cancelled',
    actor: { id: actorId },
    agency_id: remediation.agency_id,
    target: { type: 'remediation', id: remediationId },
    context: { triggerType: remediation.trigger_type },
  }).catch(() => {});

  return { success: true };
}
