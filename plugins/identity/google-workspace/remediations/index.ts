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
import { flagMissingIdentityHandler } from './handlers/flag-missing-identity.js';
import { flagInactiveIdentityHandler } from './handlers/flag-inactive-identity.js';
import { flagFederationOrphanHandler } from './handlers/flag-federation-orphan.js';

export const PLUGIN_KEY = 'google-workspace';

const googleWorkspaceRemediations: PluginRemediationModule = {
  pluginKey: PLUGIN_KEY,
  actionHandlers: {
    'google-workspace:recreate_synthetic_identity': recreateSyntheticIdentityHandler,
    'google-workspace:flag_missing_identity': flagMissingIdentityHandler,
    'google-workspace:flag_inactive_identity': flagInactiveIdentityHandler,
    'google-workspace:flag_federation_orphan': flagFederationOrphanHandler,
  },
  templates: [
    {
      key: 'drift-flag-missing-gws-identity',
      name: 'Drift — Flag Missing Google Workspace Human Identity',
      description:
        'Flags a HUMAN_INTERACTIVE identity whose email is absent from the GWS directory cache. Sets provisioning_status to not_found and notifies admins for manual review. Does not auto-revoke grants or delete the identity.',
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
            actionType: 'google-workspace:flag_missing_identity',
            params: {},
          },
          next: null,
        },
      ],
    },
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
    {
      key: 'drift-flag-inactive-gws-identity',
      name: 'Drift — Flag Inactive Google Workspace Human Identity',
      description:
        'Flags a HUMAN_INTERACTIVE identity whose account exists in the GWS directory cache but is admin-disabled (is_active=false). Sets provisioning_status to inactive and notifies admins for manual review. Does not auto-revoke grants or delete the identity.',
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
            actionType: 'google-workspace:flag_inactive_identity',
            params: {},
          },
          next: null,
        },
      ],
    },
    {
      key: 'drift-flag-orphan-gws-identity',
      name: 'Drift — Flag GWS Federation Orphan',
      description:
        'Flags a provider user who exists in the GWS managed OU but has no AccessHive identity record. Publishes an audit event and notifies admins for manual disposition. Does not auto-create an identity, auto-revoke grants, or delete anything.',
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
            actionType: 'google-workspace:flag_federation_orphan',
            params: {},
          },
          next: null,
        },
      ],
    },
  ],
};

export default googleWorkspaceRemediations;
