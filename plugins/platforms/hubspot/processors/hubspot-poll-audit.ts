/**
 * HubSpot Audit Poll — Plugin Processor (issue #101)
 *
 * HubSpot uses OAuth with refresh tokens. Refresh is TODO — the
 * current generic poller does not refresh HubSpot tokens either, so
 * behavior is preserved.
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'hubspot_poll_audit',
  pluginKey: 'hubspot',
  pollAuditEvents,
});
