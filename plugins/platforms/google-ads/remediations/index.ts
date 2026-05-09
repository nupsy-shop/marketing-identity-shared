/**
 * Google Ads Platform — Plugin Remediation Module
 *
 * Registers platform-specific drift templates + action handlers for Google Ads.
 *
 * Templates registered:
 *   - `drift-revoke-google-ads-grant`     — UNAUTHORIZED_GRANT path. Auto-revokes
 *     the user access binding via the runtime service-locator (generic wrapper).
 *     Falls back to flag-only when the locator is not registered (e.g. worker).
 *   - `drift-flag-google-ads-audit-event` — UNAUTHORIZED_REVOKE path (flag-only).
 *     No auto-restore by design — re-granting is too risky; could undo
 *     legitimate admin cleanup.
 *
 * Auth note: Google Ads developer token is read from
 * `process.env.GOOGLE_ADS_DEVELOPER_TOKEN` inside the API layer — no
 * special auth fields required beyond the OAuth access token.
 *
 * Rule-matcher routing (resolveDriftTemplateKeys):
 *   UNAUTHORIZED_GRANT → drift-revoke-google-ads-grant → drift-flag-google-ads-audit-event → generic
 *   UNAUTHORIZED_REVOKE → drift-flag-google-ads-audit-event → generic (revoke template skipped)
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';
import { buildPlatformRevokeHandler } from '../../common/build-revoke-handler.js';

const PLUGIN_KEY = 'google-ads';

const googleAdsRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'google-ads:revoke_unauthorized_grant': buildPlatformRevokeHandler(PLUGIN_KEY),
  },
  templates: [
    {
      key: 'drift-revoke-google-ads-grant',
      name: 'Drift — Google Ads Revoke Unauthorized Grant',
      description:
        "Auto-revokes a Google Ads user access binding granted outside AccessHive. Calls the platform plugin's revokeAccess via the runtime service-locator (generic wrapper). Developer token is read from GOOGLE_ADS_DEVELOPER_TOKEN env. On worker (locator unregistered) or any failure, falls back to flag-and-notify behavior.",
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'google-ads:revoke_unauthorized_grant', params: {} }, next: null },
      ],
    },
    {
      key: 'drift-flag-google-ads-audit-event',
      name: 'Drift — Google Ads Audit Event Flag',
      description:
        'Google Ads-specific override of the generic platform-audit drift template. Used for the UNAUTHORIZED_REVOKE path (flag-and-notify, no auto-restore). Also serves as the fallback if drift-revoke-google-ads-grant is not found. Uses the central flag_platform_audit_event action handler.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default googleAdsRemediations;
