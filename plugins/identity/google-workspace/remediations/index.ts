/**
 * Google Workspace — Plugin Remediation Module (issue #89).
 *
 * Contributes the `google-workspace:recreate_synthetic_identity` handler
 * and the `drift-recreate-gws-synthetic-identity` workflow template for
 * autonomous drift recovery of service accounts, shared inboxes, and bots
 * on Google Workspace. JML owns GW user drift; synthetic identities are
 * not in JML's scope and are handled here.
 *
 * Registered from `shared/plugins/identity/remediations-registry.ts`.
 */

import type { PluginRemediationModule } from '../../common/remediation-contract.js';
import { recreateSyntheticIdentityHandler } from './handlers/recreate-synthetic-identity.js';

export const PLUGIN_KEY = 'google-workspace';

const googleWorkspaceRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'google-workspace:recreate_synthetic_identity': recreateSyntheticIdentityHandler,
  },
  templates: [
    {
      key: 'drift-recreate-gws-synthetic-identity',
      name: 'Drift — Recreate Google Workspace Synthetic Identity',
      description:
        'Autonomous recovery for Google Workspace synthetic identities (service accounts, shared inboxes, bots) whose directory user is missing or unprovisioned. Re-invokes the GWS provision processor; a healthy identity is a no-op.',
      trigger_type: 'drift.detected',
      tier: 'free',
      steps: [
        {
          id: 'step-1',
          type: 'trigger',
          config: { eventType: 'drift.detected' },
          next: 'step-2',
        },
        {
          id: 'step-2',
          type: 'action',
          config: {
            actionType: 'google-workspace:recreate_synthetic_identity',
            params: {},
          },
          next: 'step-3',
        },
        {
          id: 'step-3',
          type: 'notification',
          config: {
            channels: ['in_app'],
            templateKey: 'drift_remediation_completed',
            recipientType: 'role',
            recipientRole: 'admin',
          },
          next: null,
        },
      ],
    },
  ],
};

export default googleWorkspaceRemediations;
