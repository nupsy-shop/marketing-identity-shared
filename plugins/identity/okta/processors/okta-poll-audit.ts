/**
 * Okta Audit Poll — Plugin Processor (issue #101)
 *
 * Okta uses a long-lived SSWS API token stored in oauth_tokens; no
 * refresh flow applies. The `oktaDomain` required by the adapter is
 * pulled from agency_platforms.connection_config.
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'okta_poll_audit',
  pluginKey: 'okta',
  pollAuditEvents,
  buildAdapterExtras: (ap) => {
    const cfg = (ap.connection_config ?? {}) as Record<string, unknown>;
    const oktaDomain = typeof cfg.oktaDomain === 'string' ? cfg.oktaDomain : undefined;
    return oktaDomain ? { oktaDomain } : {};
  },
});
