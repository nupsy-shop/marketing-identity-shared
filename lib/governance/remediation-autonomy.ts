/**
 * Autonomy matrix for drift remediation (issues #90, #89).
 *
 * Centralises the `(source_plugin_key, principal_type) → coverage`
 * decision so new IdPs flip a cell instead of editing orchestration.
 *
 *   | IdP                        | Principal            | Coverage                |
 *   |----------------------------|----------------------|-------------------------|
 *   | Keycloak (Local Directory) | any                  | auto                    |
 *   | google-workspace / entra-id| user                 | skip: jml_owns_users    |
 *   | google-workspace / entra-id| synthetic_identity   | auto (issue #89)        |
 *   | (other combinations)       |                      | skip: deferred_to_pr_e  |
 *
 * Pure function — unit-tested in isolation. No I/O.
 */

export type AutonomyDecision =
  | { coverage: 'auto' }
  | { coverage: 'skip'; reason: 'jml_owns_users' | 'deferred_to_pr_e' };

export function evaluateAutonomy(
  sourcePluginKey: string,
  principalType: string,
): AutonomyDecision {
  if (sourcePluginKey === 'local-directory') {
    return { coverage: 'auto' };
  }

  const isJmlOwned =
    sourcePluginKey === 'google-workspace' || sourcePluginKey === 'entra-id';

  if (isJmlOwned && principalType === 'user') {
    return { coverage: 'skip', reason: 'jml_owns_users' };
  }

  // Issue #89: synthetic identities on GW + Entra are auto-remediated by
  // the plugin-owned `recreate_synthetic_identity` handlers.
  if (isJmlOwned && principalType === 'synthetic_identity') {
    return { coverage: 'auto' };
  }

  // Any unmapped combination defers explicitly — no silent drops.
  return { coverage: 'skip', reason: 'deferred_to_pr_e' };
}
