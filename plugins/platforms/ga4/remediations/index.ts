/**
 * GA4 Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for GA4.
 *
 * Templates registered:
 *   - `drift-revoke-ga4-grant`      — UNAUTHORIZED_GRANT path. Auto-revokes
 *     the access binding via the runtime service-locator. Falls back to
 *     flag-only when the locator is not registered (e.g. worker).
 *   - `drift-flag-ga4-audit-event`  — UNAUTHORIZED_REVOKE path (flag-only).
 *     No auto-restore by design — re-granting is too risky; could undo
 *     legitimate admin cleanup.
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-ga4-grant → drift-flag-ga4-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-ga4-audit-event → generic (revoke template skipped)
 */

import type {
  PluginRemediationModule,
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
} from '../../../identity/common/remediation-contract.js';
import { getRuntime } from '../../../../lib/runtime.js';
import { publishAuditEvent } from '../../../../lib/audit/publisher.js';

// ── ga4:revoke_unauthorized_grant handler ────────────────────────────────────

const ga4RevokeUnauthorizedGrant = async (
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
  const ga4Revoke = revokePlatformAccess?.['ga4'];

  let revoked = false;
  let details: string;

  if (!ga4Revoke) {
    details = 'revokePlatformAccess.ga4 not registered on this runtime — falling back to flag-only';
  } else if (!userEmail) {
    details = 'GA4 auto-revoke: missing userEmail in trigger context';
  } else {
    const result = await ga4Revoke(instance.agency_id, userEmail, resource);
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
      sourcePluginKey: sourcePluginKey ?? 'ga4',
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
    actionType: 'ga4:revoke_unauthorized_grant',
    executedAt: new Date().toISOString(),
    revoked,
    details,
  };
};

// ── Module export ─────────────────────────────────────────────────────────────

const ga4Remediations: PluginRemediationModule = {
  pluginKey: 'ga4',
  actionHandlers: {
    'ga4:revoke_unauthorized_grant': ga4RevokeUnauthorizedGrant,
  },
  templates: [
    {
      key: 'drift-revoke-ga4-grant',
      name: 'Drift — GA4 Revoke Unauthorized Grant',
      description:
        'Auto-revokes a GA4 access binding granted outside AccessHive. Looks up the binding by user email + property ID and calls deleteAccessBinding via the runtime service-locator. On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'ga4:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-ga4-audit-event',
      name: 'Drift — GA4 Audit Event Flag',
      description:
        'GA4-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-ga4-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default ga4Remediations;
