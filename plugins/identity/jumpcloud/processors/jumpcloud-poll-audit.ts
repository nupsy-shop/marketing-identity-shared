/**
 * JumpCloud Audit Poll — Plugin Processor (issue #101)
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'jumpcloud_poll_audit',
  pluginKey: 'jumpcloud',
  pollAuditEvents,
  buildAdapterExtras: (ap) => {
    const cfg = (ap.connection_config ?? {}) as Record<string, unknown>;
    const orgId = typeof cfg.jumpcloudOrgId === 'string' ? cfg.jumpcloudOrgId : undefined;
    return orgId ? { orgId } : {};
  },
});
