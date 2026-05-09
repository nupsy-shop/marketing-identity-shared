/**
 * Shared platform-revoke handler factory.
 *
 * Creates a `<plugin>:revoke_unauthorized_grant` action handler for any
 * platform plugin. All 5 batch-5 platforms (google-ads, gtm, hubspot,
 * meta, salesforce) use this; GA4 has its own inline handler (kept as-is
 * since it was the reference impl for this pattern).
 *
 * Handler semantics:
 *   - Worker scenario (revokePlatformAccess not registered in runtime) →
 *       revoked:false, audit eventType `platform.drift.flagged`
 *   - Missing userEmail in trigger context →
 *       revoked:false, audit eventType `platform.drift.flagged`
 *   - Registered + revoke succeeds →
 *       revoked:true, audit eventType `platform.drift.revoked`
 *   - Registered + revoke fn returns revoked:false →
 *       revoked:false, audit eventType `platform.drift.flagged`
 *
 * All errors are caught inside the locator's revoke fn; the handler
 * never throws — it always returns a valid PluginActionResult.
 */

import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
} from '../../identity/common/remediation-contract.js';
import { getRuntime } from '../../../lib/runtime.js';
import { publishAuditEvent } from '../../../lib/audit/publisher.js';

/**
 * Returns an action handler function for `<pluginKey>:revoke_unauthorized_grant`.
 *
 * @param pluginKey - The platform plugin key (e.g. 'google-ads', 'gtm').
 */
export function buildPlatformRevokeHandler(pluginKey: string) {
  return async (
    _params: Record<string, unknown>,
    context: PluginWorkflowContext,
    instance: PluginWorkflowInstance,
  ): Promise<PluginActionResult> => {
    const triggerCtx = (context.trigger ?? {}) as Record<string, unknown>;
    const userEmail = triggerCtx.userEmail as string | undefined;
    const resource = triggerCtx.resource as { type?: string; id?: string; name?: string } | undefined;
    const driftType = triggerCtx.driftType as string | undefined;
    const sourcePluginKey = triggerCtx.sourcePluginKey as string | undefined;

    const { revokePlatformAccess } = getRuntime();
    const revokeFn = revokePlatformAccess?.[pluginKey];

    let revoked = false;
    let details: string;

    if (!revokeFn) {
      details = `revokePlatformAccess.${pluginKey} not registered on this runtime — falling back to flag-only`;
    } else if (!userEmail) {
      details = `${pluginKey} auto-revoke: missing userEmail in trigger context`;
    } else {
      const result = await revokeFn(instance.agency_id, userEmail, resource);
      revoked = result.revoked;
      details = result.details ?? (revoked ? 'revoked' : 'not revoked');
    }

    publishAuditEvent({
      eventType: revoked ? 'platform.drift.revoked' : 'platform.drift.flagged',
      source: 'accesshive',
      severity: 'critical',
      actor: { id: 'system', type: 'system' },
      agency: { id: instance.agency_id },
      resource,
      context: {
        sourcePluginKey: sourcePluginKey ?? pluginKey,
        driftType,
        userEmail,
        workflowInstanceId: instance.id,
        revoked,
        details,
        processedAt: new Date().toISOString(),
      },
    }).catch(() => {});

    return {
      actionCompleted: true,
      actionType: `${pluginKey}:revoke_unauthorized_grant`,
      executedAt: new Date().toISOString(),
      revoked,
      details,
    };
  };
}
