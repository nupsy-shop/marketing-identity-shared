/**
 * Salesforce Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for Salesforce.
 *
 * Templates registered:
 *   - `drift-revoke-salesforce-grant`     — UNAUTHORIZED_GRANT path. Auto-revokes
 *     (deactivates) the Salesforce user via the runtime service-locator (generic
 *     wrapper). Falls back to flag-only when the locator is not registered
 *     (e.g. worker).
 *   - `drift-flag-salesforce-audit-event` — UNAUTHORIZED_REVOKE path (flag-only).
 *
 * Auth note: instanceUrl is read from the agency's oauth_tokens.metadata
 * field by the generic wrapper and passed via params.options.instanceUrl.
 * If absent, the plugin defaults to https://login.salesforce.com.
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-salesforce-grant → drift-flag-salesforce-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-salesforce-audit-event → generic (revoke template skipped)
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';
import { buildPlatformRevokeHandler } from '../../common/build-revoke-handler.js';

const PLUGIN_KEY = 'salesforce';

const salesforceRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'salesforce:revoke_unauthorized_grant': buildPlatformRevokeHandler(PLUGIN_KEY),
  },
  templates: [
    {
      key: 'drift-revoke-salesforce-grant',
      name: 'Drift — Salesforce Revoke Unauthorized Grant',
      description:
        "Auto-revokes (deactivates) a Salesforce user granted outside AccessHive. Finds the user by email and deactivates them via the REST API, called through the runtime service-locator (generic wrapper). instanceUrl is sourced from the agency's oauth_tokens metadata. On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.",
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'salesforce:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-salesforce-audit-event',
      name: 'Drift — Salesforce Audit Event Flag',
      description:
        'Salesforce-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-salesforce-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default salesforceRemediations;
