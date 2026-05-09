/**
 * google-workspace:flag_inactive_identity
 *
 * Drift remediation for HUMAN_INTERACTIVE identities whose provider account
 * exists in the GWS directory cache but is admin-disabled (is_active=false).
 * Marks the identity as `inactive`, publishes an audit event, and notifies
 * admins for manual review.
 *
 * Does NOT auto-revoke grants. Does NOT delete the identity row.
 *
 * Delegates to the shared `flagInactiveIdentity` util so GWS and Entra share
 * identical logic with zero duplication.
 */

import { flagInactiveIdentity } from '../../../common/flag-inactive-identity.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
  RemediationActionHandler,
} from '../../../common/remediation-contract.js';

export const flagInactiveIdentityHandler: RemediationActionHandler = async (
  params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> => {
  return flagInactiveIdentity('google-workspace', params, context, instance);
};
