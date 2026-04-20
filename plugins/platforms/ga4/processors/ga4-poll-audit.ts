/**
 * GA4 Audit Poll — Plugin Processor (issue #101)
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';
import { makeGoogleRefresher } from '../../../_audit/google-refresh.js';

export default createPlatformAuditProcessor({
  jobName: 'ga4_poll_audit',
  pluginKey: 'ga4',
  pollAuditEvents,
  refreshAccessToken: makeGoogleRefresher(
    // GA4 prefers its dedicated client; falls back to the shared client.
    // Empty env means "use fallback" — the helper resolves the actual
    // var by name at call time and returns null if neither is set.
    'GOOGLE_GA4_CLIENT_ID',
    'GOOGLE_GA4_CLIENT_SECRET',
  ),
});
