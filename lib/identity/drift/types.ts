/**
 * Shared types for drift detection across Identities, Users, Groups tabs.
 *
 * Moved from `lib/identity/drift/types.ts` (web tree) so the shared submodule
 * can be used from the Bull worker. The web-tree path re-exports from here
 * during the deprecation window.
 */

export type DriftReason =
  | 'missing'           // Identity email not in provider table
  | 'inactive'          // Identity email present but marked inactive
  | 'wrong_ou'          // GWS-only: wrong organizational unit
  | 'deleted'           // Group or user no longer exists in the IdP
                        // (mirror row present with is_active=false)
  | 'renamed'           // Group display_name or email changed since binding
  | 'not_in_local_dir'  // User in JML scope but not in local users table
  | 'named_invite_unresolvable' // Named invite target doesn't exist in any IdP
  | 'orphan_in_federation';      // Provider user sits in federated space (managed
                                 // GWS OU or federated Entra domain) but has no
                                 // matching integration_identities row

export interface Drift {
  reason: DriftReason;
  details?: string;
}

export interface NamedInviteDrift {
  requestItemId: string;
  requestId: string;
  clientId: string;
  clientName: string;
  targetEmail: string;
  status: string; // 'pending' | 'approved' | 'provisioned'
}

export interface IdentityDriftItem {
  /**
   * Integration-identity UUID when this row represents a real identity.
   * For orphan rows synthesized by `orphan_in_federation` drift, this is a
   * synthetic string `orphan:<email>` (not a UUID) so React keys stay unique
   * while the caller can still discriminate by drift reason.
   */
  identityId: string;
  email: string;
  clientId: string | null;
  clientName: string | null;
  /** Role (e.g. USER/SERVICE_ACCOUNT). Empty string for orphan rows. */
  role: string;
  /** Provisioning status. Empty string for orphan rows. */
  provisioningStatus: string;
  drift: Drift | null;
}

export interface UserRow {
  email: string;
  displayName: string;
  department: string | null;
  isActive: boolean;
  /**
   * JML-scope membership for this user.
   *   null  → JML is not configured / this source is not the JML owner
   *   true  → configured and in scope
   *   false → configured and out of scope
   */
  inJmlScope: boolean | null;
  existsLocally: boolean;
  namedInvites: NamedInviteDrift[];
  drift: Drift | null; // computed: if inJmlScope === true && !existsLocally → not_in_local_dir
  /**
   * Whether this user matters to the application.
   *   - true  when the user is in JML scope (owner source) OR matches a
   *     named-invite target (any source)
   *   - false when neither applies; rendered as "Out of Scope" in the UI
   *     and filtered out of the default Users-tab view
   */
  mattersToApp: boolean;
}

export interface GroupRow {
  id: string;
  sourceId: string;
  externalId: string;
  displayName: string;
  email: string | null;
  description: string | null;
  memberCount: number;
  isActive: boolean;
  inUse: boolean;
  drift: Drift | null;
}

export type ProviderKey = 'google-workspace' | 'entra-id';

/**
 * Canonical shape of `identity_sources.jml_scope`, written by the JML setup
 * wizard. `null` means JML is not configured for this source.
 * Written by the JML setup wizard at
 * `app/admin/settings/jml-automation/setup/scope/page.tsx`.
 *
 *   - { type: 'entire_org' }                                        (GWS)
 *   - { type: 'entire_directory' }                                  (Entra)
 *   - { type: 'org_units'; orgUnitPaths?: string[] }                (GWS)
 *   - { type: 'group'; groupId?: string; groupEmail?: string }      (GWS)
 *   - { type: 'groups'; groupIds?: string[] }                       (Entra)
 */
export type JmlScopeShape =
  | { type: 'entire_org' }
  | { type: 'entire_directory' }
  | { type: 'org_units'; orgUnitPaths?: string[] }
  | { type: 'group'; groupId?: string; groupEmail?: string }
  | { type: 'groups'; groupIds?: string[] }
  | null;

/**
 * Canonical shape of the federated-space fields in
 * `identity_sources.connection_config`.
 *   - GWS: `managedOuPath` — accounts whose org_unit_path startsWith this
 *     value are in the federated space for GWS sources.
 *   - Entra: `federatedDomains` — accounts whose UPN/email domain matches
 *     any of these are in the federated space for Entra sources.
 */
export type ConnectionConfigShape = {
  managedOuPath?: string;
  federatedDomains?: string[];
};
