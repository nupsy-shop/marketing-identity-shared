/**
 * Source-level gating for principal-drift emissions.
 *
 * Runs AFTER upsertAndDedupe and BEFORE evaluateAndRemediate. Short-circuits
 * remediation dispatch when the source's operator-configured settings
 * disallow it — the finding is still persisted (drift_findings stays an
 * honest mirror), only the workflow trigger is suppressed.
 *
 * Reasons:
 *   - provisioning_disabled   — identity_sources.provisioning_enabled = false
 *   - source_disconnected     — identity_sources.connection_state = 'disconnected'
 *   - auto_provision_disabled — connection_config.autoProvisionUsers = false
 *                               AND the drift type is user-creating
 */

export type GateReason =
  | 'provisioning_disabled'
  | 'source_disconnected'
  | 'auto_provision_disabled';

export interface SourceSettings {
  provisioningEnabled: boolean;
  connectionState: 'connected' | 'degraded' | 'disconnected' | string;
  autoProvisionUsers: boolean | undefined;
}

export type SourceGateResult =
  | { allow: true }
  | { allow: false; reason: GateReason };

/**
 * Drift types that result in USER creation on the provider. These are
 * gated by autoProvisionUsers. Add new drift types here as templates grow.
 */
const USER_CREATING_DRIFT_TYPES = new Set<string>([
  'keycloak_missing', // local-directory:link_keycloak_identity creates a KC user
]);

export function evaluateSourceGates(
  source: SourceSettings,
  driftType: string,
): SourceGateResult {
  if (source.connectionState === 'disconnected') {
    return { allow: false, reason: 'source_disconnected' };
  }
  if (!source.provisioningEnabled) {
    return { allow: false, reason: 'provisioning_disabled' };
  }
  if (
    USER_CREATING_DRIFT_TYPES.has(driftType) &&
    source.autoProvisionUsers === false
  ) {
    return { allow: false, reason: 'auto_provision_disabled' };
  }
  return { allow: true };
}
