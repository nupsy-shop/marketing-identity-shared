/**
 * GTM Audit Poll — Plugin Processor (issue #101)
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';
import { makeGoogleRefresher } from '../../../_audit/google-refresh.js';

export default createPlatformAuditProcessor({
  jobName: 'gtm_poll_audit',
  pluginKey: 'gtm',
  pollAuditEvents,
  refreshAccessToken: makeGoogleRefresher('GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET'),
});
