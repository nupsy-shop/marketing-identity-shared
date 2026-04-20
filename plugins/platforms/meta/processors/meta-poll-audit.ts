/**
 * Meta Audit Poll — Plugin Processor (issue #101)
 *
 * Polls Meta Marketing API ad-account activities via the plugin's
 * audit adapter. See shared/lib/audit/platform-audit-factory.ts for
 * the shared behavior (eligibility, OAuth token, cursor, publish).
 *
 * Meta has no refresh-token flow in oauth_tokens today — long-lived
 * page/user tokens are used. No refresher is wired; on expiry the
 * factory flips `auditScopeAuthorized=false` and emits
 * `audit.platform.token_expired`.
 */

import { createPlatformAuditProcessor } from '../../../../lib/audit/platform-audit-factory.js';
import { pollAuditEvents } from '../audit-adapter.js';

export default createPlatformAuditProcessor({
  jobName: 'meta_poll_audit',
  pluginKey: 'meta',
  pollAuditEvents,
});
