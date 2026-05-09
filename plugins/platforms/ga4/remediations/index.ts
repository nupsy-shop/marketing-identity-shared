/**
 * GA4 Platform — Plugin Remediation Module
 *
 * Registers a platform-specific drift template for GA4 audit events.
 * Serves as both a working override of the generic `drift-flag-platform-audit-event`
 * template and a registration point for future GA4-specific remediation actions
 * (e.g. auto-revoke of unauthorized property access bindings).
 *
 * Currently reuses the central `flag_platform_audit_event` action handler —
 * no custom GA4 action implementation in this PR. A follow-up PR can replace
 * this with a `ga4:revoke_access_binding` handler that calls
 * `deleteAccessBinding` via getRuntime() service locator.
 *
 * The template key `drift-flag-ga4-audit-event` is tried BEFORE the generic
 * `drift-flag-platform-audit-event` by the rule-matcher (`resolveDriftTemplateKeys`
 * returns a priority-ordered candidate list). This gives GA4 a seeded override
 * slot without changing the generic behaviour for other platforms.
 */

import type { PluginRemediationModule } from '../../../identity/common/remediation-contract.js';

const ga4Remediations: PluginRemediationModule = {
  pluginKey: 'ga4',
  actionHandlers: {
    // No GA4-specific action handlers yet. Future PR: add ga4:revoke_access_binding.
  },
  templates: [
    {
      key: 'drift-flag-ga4-audit-event',
      name: 'Drift — GA4 Audit Event Flag',
      description:
        'GA4-specific override of the generic platform-audit drift template. Currently uses the same flag-and-notify action as the generic; serves as a registration point for future GA4-specific remediation (e.g., auto-revoke unauthorized property access bindings).',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        { id: 'step-1', type: 'trigger', config: { eventType: 'drift.detected' }, next: 'step-2' },
        { id: 'step-2', type: 'action', config: { actionType: 'flag_platform_audit_event', params: {} }, next: null },
      ],
    },
  ],
};

export default ga4Remediations;
