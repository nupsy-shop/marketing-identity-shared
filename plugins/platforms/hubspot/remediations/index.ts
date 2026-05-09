/**
 * HubSpot Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for HubSpot.
 *
 * Templates registered:
 *   - `drift-revoke-hubspot-grant`     — UNAUTHORIZED_GRANT path. Auto-revokes
 *     the HubSpot user via the runtime service-locator (generic wrapper).
 *     Falls back to flag-only when the locator is not registered (e.g. worker).
 *   - `drift-flag-hubspot-audit-event` — UNAUTHORIZED_REVOKE path (flag-only).
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-hubspot-grant → drift-flag-hubspot-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-hubspot-audit-event → generic (revoke template skipped)
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';
import { buildPlatformRevokeHandler } from '../../common/build-revoke-handler.js';

const PLUGIN_KEY = 'hubspot';

const hubspotRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'hubspot:revoke_unauthorized_grant': buildPlatformRevokeHandler(PLUGIN_KEY),
  },
  templates: [
    {
      key: 'drift-revoke-hubspot-grant',
      name: 'Drift — HubSpot Revoke Unauthorized Grant',
      description:
        "Auto-revokes a HubSpot user granted outside AccessHive. Finds the user by email and removes them via the portal users API, called through the runtime service-locator (generic wrapper). On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.",
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'hubspot:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-hubspot-audit-event',
      name: 'Drift — HubSpot Audit Event Flag',
      description:
        'HubSpot-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-hubspot-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default hubspotRemediations;
