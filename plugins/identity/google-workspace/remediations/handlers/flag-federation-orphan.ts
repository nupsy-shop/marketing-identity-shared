/**
 * google-workspace:flag_federation_orphan
 *
 * Drift remediation for federation orphans: provider users in the GWS managed
 * OU that have no matching AccessHive identity record. Emits an audit event
 * and notifies admins for manual disposition.
 *
 * Does NOT auto-create an identity. Does NOT auto-revoke grants.
 * Does NOT delete anything. Flag-and-notify ONLY (Option B).
 *
 * Delegates to the shared `flagFederationOrphan` util so GWS and Entra share
 * identical logic with zero duplication.
 */

import { flagFederationOrphan } from '../../../common/flag-federation-orphan.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
  RemediationActionHandler,
} from '../../../common/remediation-contract.js';

export const flagFederationOrphanHandler: RemediationActionHandler = async (
  params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> => {
  return flagFederationOrphan('google-workspace', params, context, instance);
};
