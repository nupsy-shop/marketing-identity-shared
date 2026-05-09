/**
 * Meta Platform — Plugin Remediation Module
 *
 * Registers a platform-specific drift template for meta audit events.
 * Currently reuses the central `flag_platform_audit_event` action handler —
 * no custom meta-specific action implementation in this PR. Follow-up PR
 * can replace this with `meta:revoke_*` handlers via the runtime
 * service-locator pattern.
 *
 * The template key `drift-flag-meta-audit-event` is tried BEFORE the
 * generic `drift-flag-platform-audit-event` by the rule-matcher.
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';

const metaRemediations: PluginRemediationModule = {
  pluginKey: 'meta',
  actionHandlers: {},
  templates: [
    {
      key: 'drift-flag-meta-audit-event',
      name: 'Drift — Meta Audit Event Flag',
      description:
        'Meta-specific override of the generic platform-audit drift template. Currently uses the same flag-and-notify action as the generic; serves as a registration point for future Meta-specific remediation.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default metaRemediations;
