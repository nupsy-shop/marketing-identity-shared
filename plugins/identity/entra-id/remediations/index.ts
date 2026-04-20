/**
 * Entra ID — Plugin Remediation Module (issue #89).
 *
 * Contributes the `entra-id:recreate_synthetic_identity` handler + the
 * `drift-recreate-entra-synthetic-identity` workflow template. Mirrors
 * the Google Workspace module; JML owns Entra user drift, synthetic
 * identities (service accounts, shared mailboxes, bots) are handled here.
 *
 * Registered from `shared/plugins/identity/remediations-registry.ts`.
 */

import type { PluginRemediationModule } from '../../common/remediation-contract.js';
import { recreateSyntheticIdentityHandler } from './handlers/recreate-synthetic-identity.js';

export const PLUGIN_KEY = 'entra-id';

const entraIdRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'entra-id:recreate_synthetic_identity': recreateSyntheticIdentityHandler,
  },
  templates: [
    {
      key: 'drift-recreate-entra-synthetic-identity',
      name: 'Drift — Recreate Entra ID Synthetic Identity',
      description:
        'Autonomous recovery for Entra ID synthetic identities (service accounts, shared mailboxes, bots) whose directory object is missing or unprovisioned. Re-invokes the Entra provision processor; a healthy identity is a no-op.',
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
            actionType: 'entra-id:recreate_synthetic_identity',
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

export default entraIdRemediations;
