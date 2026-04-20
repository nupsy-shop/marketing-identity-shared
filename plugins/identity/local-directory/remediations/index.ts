/**
 * Local Directory — Plugin Remediation Module
 *
 * Contributes drift-remediation action handlers + workflow templates to the
 * central workflow engine via the plugin remediations registry
 * (`shared/plugins/identity/remediations-registry.ts`).
 *
 * Convention: each handler key and each template-step `actionType` is
 * namespaced as `${pluginKey}:${actionName}` — here `local-directory:...`.
 * Boot-time validation enforces this (see registry).
 */

import type { PluginRemediationModule } from '../../common/remediation-contract.js';
import { linkKeycloakIdentityHandler } from './handlers/link-keycloak-identity.js';

export const PLUGIN_KEY = 'local-directory';

const localDirectoryRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'local-directory:link_keycloak_identity': linkKeycloakIdentityHandler,
  },
  templates: [
    {
      key: 'drift-link-keycloak-identity',
      name: 'Drift — Link Keycloak Identity',
      description:
        'Autonomous recovery for Local Directory identities missing their Keycloak user. Looks up or creates the Keycloak user and links it back to the directory row.',
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
            actionType: 'local-directory:link_keycloak_identity',
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

export default localDirectoryRemediations;
