/**
 * Meta Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for Meta.
 *
 * Templates registered:
 *   - `drift-revoke-meta-grant`     — UNAUTHORIZED_GRANT path. Auto-revokes
 *     the Meta ad account user via the runtime service-locator (generic
 *     wrapper). Falls back to flag-only when the locator is not registered
 *     (e.g. worker).
 *   - `drift-flag-meta-audit-event` — UNAUTHORIZED_REVOKE path (flag-only).
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-meta-grant → drift-flag-meta-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-meta-audit-event → generic (revoke template skipped)
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';
import { buildPlatformRevokeHandler } from '../../common/build-revoke-handler.js';

const PLUGIN_KEY = 'meta';

const metaRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'meta:revoke_unauthorized_grant': buildPlatformRevokeHandler(PLUGIN_KEY),
  },
  templates: [
    {
      key: 'drift-revoke-meta-grant',
      name: 'Drift — Meta Revoke Unauthorized Grant',
      description:
        "Auto-revokes a Meta ad account user granted outside AccessHive. Finds the user on the ad account and removes them via the Business Manager API, called through the runtime service-locator (generic wrapper). On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.",
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'meta:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-meta-audit-event',
      name: 'Drift — Meta Audit Event Flag',
      description:
        'Meta-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-meta-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default metaRemediations;
