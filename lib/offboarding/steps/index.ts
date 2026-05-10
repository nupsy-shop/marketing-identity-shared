/**
 * Barrel for the six client-offboarding step handlers.
 *
 * Each handler is idempotent, owns its `offboarding_run_steps` row, and
 * emits scoped audit events with `cause='client_offboarded'`. Handlers
 * are wired into Bull processors in the worker repo.
 */

export { runRevokeAccess } from './revoke-access.js';
export { runDisableIdentities } from './disable-identities.js';
export { runUnassignTeam } from './unassign-team.js';
export { runPauseScimAndRemediation } from './pause-scim-and-remediation.js';
export { runDenyPendingRequests } from './deny-pending-requests.js';
export { runFinalize } from './finalize.js';
export type { StepContext } from './_runner.js';

/**
 * Canonical step-key list, used to enforce one-row-per-step and to
 * order the chain in the execute endpoint.
 */
export const OFFBOARDING_STEP_KEYS = [
  'client_offboard_revoke_access',
  'client_offboard_disable_identities',
  'client_offboard_unassign_team',
  'client_offboard_pause_scim_and_remediation',
  'client_offboard_deny_pending_requests',
  'client_offboard_finalize',
] as const;

export type OffboardingStepKey = (typeof OFFBOARDING_STEP_KEYS)[number];
