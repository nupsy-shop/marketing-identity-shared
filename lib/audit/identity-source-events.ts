/**
 * Audit event type constants for identity source operations.
 *
 * These string constants are passed as `eventType` to `publishAuditEvent()`.
 * Keeping them in one place prevents typos and makes it easy to grep for
 * all callsites of a given event type.
 *
 * Naming convention: `<plugin>.<noun>_<verb>` where plugin is the identity
 * source plugin key (e.g. 'entra', 'gws').
 *
 * No @/ aliases — plain ESM with .js extensions.
 */

// ---------------------------------------------------------------------------
// Entra ID events
// ---------------------------------------------------------------------------

/**
 * Emitted at most once per agency per sync run when the Entra ID sync
 * encounters HTTP 403 from the Graph /authentication/methods endpoint.
 *
 * Indicates that `UserAuthenticationMethod.Read.All` has not been consented
 * by the tenant admin. The identity source's
 * `metadata.entraMfaConsentMissing` flag will be set to true.
 *
 * Consumers: UI banner on identity source settings page; SIEM forwarding.
 *
 * Top-level shape:
 *   {
 *     eventType: ENTRA_MFA_SCOPE_MISSING,
 *     action: 'scope_missing',
 *     agency: { id: <agencyId> },
 *     resource: { type: 'identity_source', id: <sourceId> },
 *     context: { syncRunId: string, affectedUserCount: number },
 *   }
 */
export const ENTRA_MFA_SCOPE_MISSING = 'entra.mfa_scope_missing';
