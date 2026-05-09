/**
 * Google Tag Manager Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for GTM.
 *
 * Templates registered:
 *   - `drift-revoke-gtm-grant`     — UNAUTHORIZED_GRANT path. Auto-revokes
 *     the user permission entry via the runtime service-locator (generic
 *     wrapper). Falls back to flag-only when the locator is not registered
 *     (e.g. worker).
 *   - `drift-flag-gtm-audit-event` — UNAUTHORIZED_REVOKE path (flag-only).
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-gtm-grant → drift-flag-gtm-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-gtm-audit-event → generic (revoke template skipped)
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';
import { buildPlatformRevokeHandler } from '../../common/build-revoke-handler.js';

const PLUGIN_KEY = 'gtm';

const gtmRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'gtm:revoke_unauthorized_grant': buildPlatformRevokeHandler(PLUGIN_KEY),
  },
  templates: [
    {
      key: 'drift-revoke-gtm-grant',
      name: 'Drift — GTM Revoke Unauthorized Grant',
      description:
        "Auto-revokes a GTM user permission entry granted outside AccessHive. Calls the platform plugin's revokeAccess via the runtime service-locator (generic wrapper). On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.",
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'gtm:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-gtm-audit-event',
      name: 'Drift — Google Tag Manager Audit Event Flag',
      description:
        'Google Tag Manager-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-gtm-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default gtmRemediations;
