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
 *
 * Includes both the internal (legacy) action strings and the persisted
 * vocabulary written by the canon JML UI.
 */
export type PolicyAction =
  // Joiner actions — internal
  | 'create_account'
  | 'notify_only'
  | 'require_approval'
  // Joiner actions — persisted canon vocabulary
  | 'auto_provision'
  | 'hold_review'
  // Leaver / suspension actions — internal
  | 'revoke_immediately'
  | 'revoke_with_grace'
  | 'disable_account'
  | 'enable_account'
  // Leaver actions — persisted canon vocabulary
  | 'immediate_revocation'
  | 'grace_period'
  | 'manual_review'
  // Suspension actions — persisted canon vocabulary
  | 'immediate_suspension'
  | 'readonly_downgrade'
  // Mover actions — internal
  | 'grant_access'
  | 'revoke_access'
  | 'use_rbac_mappings'
  // Mover actions — persisted canon vocabulary
  | 'auto_revoke'
  | 'notify_manager'
  | 'open_access_request';

/**
 * Result of resolving a (lifecycle kind, policy action, plugin) triple to a
 * Bull job to enqueue. `null` means "do nothing" — e.g. a notify-only joiner
 * policy when no notification channel is configured.
 */

/**
 * Actions that are persisted into `agency_settings.jml_policies` but the engine
 * does NOT execute yet — they resolve to `null` (no job) and, in the lifecycle
 * processor, produce a `hold` row for operator approve/deny instead.
 *
 * MUST stay in sync with the app's server-owned enforcement registry
 * (`lib/jml/enforcement-registry.ts` → `DEFERRED_ACTIONS`). A cross-repo parity
 * test (`tests/unit/jml/policy-action-map-deferred.test.ts`) asserts they match
 * so the two repos cannot drift. See docs/architecture/jml-enforcement-registry.md.
 */
export const DEFERRED_ACTIONS: ReadonlySet<string> = new Set([
  'hold_review',
  'manual_review',
  'readonly_downgrade',
  'open_access_request',
]);

/** True iff the action is configured-but-not-yet-enforced (a "hold"). */
export function isDeferredAction(action: string | undefined | null): boolean {
  return !!action && DEFERRED_ACTIONS.has(action);
}

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
      // Deferred: persisted but not yet enforced. No job enqueued.
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
      // Deferred: persisted but not yet enforced. No job enqueued.
      return null;
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
  // Deferred actions: persist but don't execute.
  if (action === 'readonly_downgrade') return null;

  // Persisted canon vocabulary: grace_period and immediate_suspension map to
  // the generic IAM-level disable/enable. Plugin-specific jobs (gws_suspend_user,
  // entra_suspend_user) are reserved for the explicit disable_account/enable_account
  // actions that come from the setup wizard.
  //
  // NOTE (follow-up): grace_period resolves to an *immediate* iam_disable_app_user
  // at this resolver level. The actual grace window (delay before enforcement)
  // is separately managed by lib/jml/scheduled-actions.ts (Heroku Scheduler),
  // which creates a jml_scheduled_actions row and executes the revocation only
  // after the configured grace_period_days have elapsed. The two concerns are
  // intentionally decoupled.
  if (action === 'grace_period' || action === 'immediate_suspension') {
    if (direction === 'suspend') return { jobType: 'iam_disable_app_user' };
    return { jobType: 'iam_enable_app_user' };
  }

  // Internal plugin-specific actions
  const isPluginSpecificDisable = action === 'disable_account';
  const isPluginSpecificEnable  = action === 'enable_account';

  if (!isPluginSpecificDisable && !isPluginSpecificEnable) {
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
    case 'auto_provision':
      // Persisted canon: 'auto_provision' on group_addition → provision path
      if (direction !== 'added') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_add_group_member' };
      // GWS / others: use the generic IAM path (provisioning hooks then
      // translate to the right per-plugin side-effects).
      return { jobType: 'iam_update_identity' };

    case 'revoke_access':
    case 'auto_revoke':
      // Persisted canon: 'auto_revoke' on group_removal → revoke path
      if (direction !== 'removed') return null;
      if (pluginKey === 'entra-id') return { jobType: 'entra_remove_group_member' };
      return { jobType: 'iam_update_identity' };

    case 'notify_only':
    case 'notify_manager':
      // Persisted canon: 'notify_manager' on group_removal → notification
      return {
        jobType: 'email_send',
        extra: { template: `jml.mover.group_${direction}` },
      };

    case 'hold_review':
    case 'open_access_request':
      // Deferred: persisted but not yet enforced. No job enqueued.
      return null;

    default:
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
