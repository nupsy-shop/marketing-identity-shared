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

/**
 * Canonical policy-action strings. Mirror the values the JML setup wizard
 * writes into `agency_settings.jml_policies`. Keeping these as a type makes
 * typos in policy data detectable at the resolution boundary.
 */
export type PolicyAction =
  // Joiner actions
  | 'create_account'
  | 'notify_only'
  | 'require_approval'
  // Leaver / suspension actions
  | 'revoke_immediately'
  | 'revoke_with_grace'
  | 'disable_account'
  | 'enable_account'
  // Mover actions — triggered when a user's group memberships or profile
  // attributes change.
  | 'grant_access'
  | 'revoke_access'
  | 'use_rbac_mappings';

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
  action: PolicyAction | undefined,
  pluginKey: string,
): ResolvedAction | null {
  switch (action) {
    case 'create_account':
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
    default:
      return null;
  }
}

/**
 * Resolve a leaver action. Plugin-specific because some deprovision paths
 * also need to update the upstream IdP (entra_suspend_user) in addition to
 * Keycloak.
 */
export function resolveLeaverAction(
  action: PolicyAction | undefined,
  pluginKey: string,
): ResolvedAction | null {
  switch (action) {
    case 'revoke_immediately':
      return { jobType: 'iam_deprovision_app_user' };
    case 'revoke_with_grace':
      // Scheduled-action machinery handles the grace window; no immediate
      // per-user job beyond an audit notification.
      return { jobType: 'email_send', extra: { template: 'jml.leaver.scheduled' } };
    case 'notify_only':
      return { jobType: 'email_send', extra: { template: 'jml.leaver' } };
    default:
      return null;
  }
}

/**
 * Resolve a suspension action. Plugin-specific because suspend/unsuspend
 * differs per IdP (gws_suspend_user vs entra_suspend_user).
 */
export function resolveSuspensionAction(
  action: PolicyAction | undefined,
  pluginKey: string,
  direction: 'suspend' | 'unsuspend',
): ResolvedAction | null {
  if (action !== 'disable_account' && action !== 'enable_account') {
    // Any other action string (or undefined) falls back to the IAM-level
    // disable/enable which is plugin-agnostic.
    if (direction === 'suspend') return { jobType: 'iam_disable_app_user' };
    return { jobType: 'iam_enable_app_user' };
  }

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
  action: PolicyAction | undefined,
  pluginKey: string,
  direction: 'added' | 'removed',
): ResolvedAction | null {
  switch (action) {
    case 'grant_access':
    case 'use_rbac_mappings':
      if (direction !== 'added') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_add_group_member' };
      // GWS / others: use the generic IAM path (provisioning hooks then
      // translate to the right per-plugin side-effects).
      return { jobType: 'iam_update_identity' };

    case 'revoke_access':
      if (direction !== 'removed') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_remove_group_member' };
      return { jobType: 'iam_update_identity' };

    case 'notify_only':
      return {
        jobType: 'email_send',
        extra: { template: `jml.mover.group_${direction}` },
      };

    default:
      return null;
  }
}

/**
 * Attribute changes (department, job_title, etc.) don't have a dedicated
 * action today — they fan out only as notifications via the mover policy's
 * notify_* flags. Callers pass the whole `policies.mover` object to
 * `resolveNotifications(..., 'mover')` and enqueue a `iam_update_identity`
 * audit trail separately if they want attribute sync to Keycloak.
 *
 * Returning the IAM update job here keeps the mirror ↔ Keycloak attribute
 * state in sync without demanding a per-policy action string.
 */
export function resolveMoverAttributeAction(
  _policy: { notify_admins?: boolean; notify_manager?: boolean } | undefined,
  _pluginKey: string,
): ResolvedAction | null {
  // Attribute drift should always bring Keycloak into alignment with the
  // directory mirror. Notifications are layered on via resolveNotifications().
  return { jobType: 'iam_update_identity' };
}

/**
 * Notification fan-out. Returns the set of notification jobs to enqueue in
 * addition to the primary action. Separate from action resolution because
 * the same lifecycle event can both fire an action and send notifications.
 */
export function resolveNotifications(
  policy: {
    notify_admins?: boolean;
    notifyAdmins?: boolean;
    notify_manager?: boolean;
    notifyManager?: boolean;
  } | undefined,
  kind: 'joiner' | 'leaver' | 'suspension' | 'mover',
): ResolvedAction[] {
  if (!policy) return [];
  const out: ResolvedAction[] = [];
  const adminsFlag = policy.notify_admins ?? policy.notifyAdmins ?? false;
  if (adminsFlag) {
    out.push({ jobType: 'email_send', extra: { template: `jml.${kind}.notify_admins` } });
  }
  const managerFlag = policy.notify_manager ?? policy.notifyManager ?? false;
  if (managerFlag) {
    out.push({ jobType: 'email_send', extra: { template: `jml.${kind}.notify_manager` } });
  }
  return out;
}
