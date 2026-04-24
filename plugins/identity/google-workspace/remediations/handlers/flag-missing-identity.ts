/**
 * google-workspace:flag_missing_identity
 *
 * Drift remediation for HUMAN_INTERACTIVE identities whose email is absent
 * from the GWS directory cache. Marks the identity as `not_found`,
 * publishes an audit event, and notifies admins for manual review.
 *
 * Does NOT auto-revoke grants. Does NOT delete the identity row.
 *
 * Delegates to the shared `flagMissingIdentity` util so GWS and Entra share
 * identical logic with zero duplication.
 */

import { flagMissingIdentity } from '../../../common/flag-missing-identity.js';
import type {
  PluginActionResult,
  PluginWorkflowContext,
  PluginWorkflowInstance,
  RemediationActionHandler,
} from '../../../common/remediation-contract.js';

export const flagMissingIdentityHandler: RemediationActionHandler = async (
  params: Record<string, unknown>,
  context: PluginWorkflowContext,
  instance: PluginWorkflowInstance,
): Promise<PluginActionResult> => {
  return flagMissingIdentity('google-workspace', params, context, instance);
};
