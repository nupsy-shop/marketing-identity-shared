/**
 * Salesforce Audit Poll — Plugin Processor (issue #101)
 *
 * Salesforce uses OAuth with refresh tokens. Refresh is TODO — the
 * current generic poller does not refresh Salesforce tokens either,
 * so behavior is preserved.
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'salesforce_poll_audit',
  pluginKey: 'salesforce',
  pollAuditEvents,
});
