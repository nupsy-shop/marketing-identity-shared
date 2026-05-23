/**
 * JML Policy Action Map
 *
 * Translates the configured `jml_policies.{joiner,leaver,suspension,mover}.action`
 * string + source plugin into the concrete Bull job type that executes that
 * action. The job's queue is derived downstream by the shared catalog —
 * callers only need to know the job type.
 *
 * Used by `processLifecycleEvents()` in `lifecycle-processor.ts` to fan out
 * per-action jobs after scope filtering and guardrails have been applied.
 *
 * Adding a new policy action requires two changes:
 *   1. Entry here mapping the action string to the job type.
 *   2. A matching entry in `shared/lib/jobs/catalog.ts` for the job type
 *      (which declares the queue).
 */

import type { JobType } from '../jobs/catalog.js';
import { logger } from '../logger.js';

/**
 * Canonical policy-action strings. Mirror the values the JML setup wizard
 * writes into `agency_settings.jml_policies`. Keeping these as a type makes
 * typos in policy data detectable at the resolution boundary.
 *
 * Includes both the LEGACY internal vocabulary and the NEW persisted vocabulary
 * that the app writes into agency_settings.jml_policies.
 */
export type PolicyAction =
  // Joiner actions — legacy
  | 'create_account'
  | 'notify_only'
  | 'require_approval'
  // Joiner actions — persisted vocabulary
  | 'auto_provision'
  | 'hold_review'
  | 'disabled'
  // Leaver / suspension actions — legacy
  | 'revoke_immediately'
  | 'revoke_with_grace'
  | 'disable_account'
  | 'enable_account'
  // Leaver actions — persisted vocabulary
  | 'immediate_revocation'
  | 'grace_period'
  | 'manual_review'
  // Suspension actions — persisted vocabulary
  | 'readonly_downgrade'
  | 'immediate_suspension'
  // Mover actions — triggered when a user's group memberships or profile
  // attributes change.
  | 'grant_access'
  | 'revoke_access'
  | 'use_rbac_mappings'
  // Mover actions — persisted vocabulary
  | 'auto_revoke'
  | 'notify_manager'
  | 'open_access_request'
  | 'do_nothing';

/**
 * Result of resolving a (lifecycle kind, policy action, plugin) triple to a
 * Bull job to enqueue. `null` means "do nothing" — e.g. a notify-only joiner
 * policy when no notification channel is configured.
 */
export interface ResolvedAction {
  jobType: JobType;
  /** Extra static data to merge into the job payload. */
  extra?: Record<string, unknown>;
}

/**
 * Resolve a joiner action. Plugin-specific because joiner actions may need
 * to provision into the upstream IdP (gws_create_user) vs. only into
 * Keycloak (iam_provision_identity).
 */
export function resolveJoinerAction(
  action: string | undefined,
  pluginKey: string,
): ResolvedAction | null {
  switch (action) {
    case 'create_account':
    case 'auto_provision':
      // Primary: provision the identity into Keycloak. Per-plugin fan-out
      // (e.g. gws_create_user) is handled by iam_provision_identity itself
      // through the provisioning hooks, keeping the map plugin-agnostic.
      return { jobType: 'iam_provision_identity' };
    case 'notify_only':
      // Email channel by default; workflow notification routing picks the
      // actual destination.
      return { jobType: 'email_send', extra: { template: 'jml.joiner' } };
    case 'require_approval':
      // Approval workflows run in-process; no per-user job to enqueue.
      return null;
    case 'hold_review':
    case 'disabled':
      // Deferred — no immediate job; handled by review/approval machinery.
      return null;
    case undefined:
      return null;
    default:
      logger.warn('[policy-action-map] unmapped joiner action', { action });
      return null;
  }
}

/**
 * Resolve a leaver action. Plugin-specific because some deprovision paths
 * also need to update the upstream IdP (entra_suspend_user) in addition to
 * Keycloak.
 */
export function resolveLeaverAction(
  action: string | undefined,
  pluginKey: string,
): ResolvedAction | null {
  switch (action) {
    case 'revoke_immediately':
    case 'immediate_revocation':
      return { jobType: 'iam_deprovision_app_user' };
    case 'revoke_with_grace':
    case 'grace_period':
      // Scheduled-action machinery handles the grace window; no immediate
      // per-user job beyond an audit notification.
      return { jobType: 'email_send', extra: { template: 'jml.leaver.scheduled' } };
    case 'notify_only':
      return { jobType: 'email_send', extra: { template: 'jml.leaver' } };
    case 'manual_review':
      // Deferred — no immediate job; handled by review machinery.
      return null;
    case undefined:
      return null;
    default:
      logger.warn('[policy-action-map] unmapped leaver action', { action });
      return null;
  }
}

/**
 * Resolve a suspension action. Plugin-specific because suspend/unsuspend
 * differs per IdP (gws_suspend_user vs entra_suspend_user).
 */
export function resolveSuspensionAction(
  action: string | undefined,
  pluginKey: string,
  direction: 'suspend' | 'unsuspend',
): ResolvedAction | null {
  // readonly_downgrade: deferred — no suspension job at all.
  if (action === 'readonly_downgrade') {
    return null;
  }

  // Plugin-specific path for explicit disable/enable and immediate_suspension actions.
  if (
    action === 'disable_account' ||
    action === 'enable_account' ||
    action === 'immediate_suspension'
  ) {
    if (pluginKey === 'google-workspace') {
      return direction === 'suspend'
        ? { jobType: 'gws_suspend_user' }
        // GWS has no dedicated unsuspend job yet; fall back to IAM enable.
        : { jobType: 'iam_enable_app_user' };
    }

    if (pluginKey === 'entra-id') {
      return direction === 'suspend'
        ? { jobType: 'entra_suspend_user' }
        : { jobType: 'entra_unsuspend_user' };
    }

    // Unknown plugin — use the generic IAM path.
    return direction === 'suspend'
      ? { jobType: 'iam_disable_app_user' }
      : { jobType: 'iam_enable_app_user' };
  }

  // All other values (grace_period, notify_only, immediate_revocation, undefined, unknown)
  // fall through to the generic IAM path.
  if (action !== undefined) {
    // Only warn for non-empty strings that aren't explicitly handled above;
    // undefined is a legitimately unset policy.
    const knownNullActions = ['grace_period', 'notify_only', 'immediate_revocation', 'manual_review'];
    if (!knownNullActions.includes(action)) {
      logger.warn('[policy-action-map] unmapped suspension action; using generic IAM fallback', { action });
    }
  }

  if (direction === 'suspend') return { jobType: 'iam_disable_app_user' };
  return { jobType: 'iam_enable_app_user' };
}

/**
 * Resolve a mover action for a group membership change.
 *
 *   direction='added'   → policies.mover.on_group_addition
 *   direction='removed' → policies.mover.on_group_removal
 *
 * Plugin-specific because group-membership mutations on the IdP side use
 * different jobs per provider (entra_add_group_member /
 * entra_remove_group_member). For providers without dedicated jobs,
 * mover events fall back to the generic IAM paths.
 */
export function resolveMoverGroupAction(
  action: string | undefined,
  pluginKey: string,
  direction: 'added' | 'removed',
): ResolvedAction | null {
  switch (action) {
    case 'grant_access':
    case 'use_rbac_mappings':
    case 'auto_provision':
      if (direction !== 'added') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_add_group_member' };
      // GWS / others: use the generic IAM path (provisioning hooks then
      // translate to the right per-plugin side-effects).
      return { jobType: 'iam_update_identity' };

    case 'revoke_access':
    case 'auto_revoke':
      if (direction !== 'removed') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_remove_group_member' };
      return { jobType: 'iam_update_identity' };

    case 'notify_only':
    case 'notify_manager':
      return {
        jobType: 'email_send',
        extra: { template: `jml.mover.group_${direction}` },
      };

    case 'hold_review':
    case 'open_access_request':
    case 'do_nothing':
    case 'grace_period':
      // Deferred — handled by review/approval/scheduled-actions machinery.
      return null;

    case undefined:
      return null;

    default:
      logger.warn('[policy-action-map] unmapped mover group action', { action });
      return null;
  }
}

/**
 * Attribute changes bring Keycloak into alignment with the directory mirror.
 * Per-event notifications are routed through `dispatchNotification` based on
 * the agency's configured notification_channels rather than hardcoded jobs.
 */
export function resolveMoverAttributeAction(
  _policy: { notify_admins?: boolean; notify_manager?: boolean } | undefined,
  _pluginKey: string,
): ResolvedAction | null {
  return { jobType: 'iam_update_identity' };
}
