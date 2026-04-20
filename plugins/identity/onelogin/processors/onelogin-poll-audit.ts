/**
 * OneLogin Audit Poll — Plugin Processor (issue #101)
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'onelogin_poll_audit',
  pluginKey: 'onelogin',
  pollAuditEvents,
  buildAdapterExtras: (ap) => {
    const cfg = (ap.admin_config_json ?? {}) as Record<string, unknown>;
    const subdomain = typeof cfg.oneloginSubdomain === 'string' ? cfg.oneloginSubdomain : undefined;
    return subdomain ? { oneloginSubdomain: subdomain } : {};
  },
});
