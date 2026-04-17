/**
 * Identity Drift Adapter interface.
 *
 * Every identity plugin that participates in drift detection (Identities,
 * Users, Groups tabs) implements this interface. Orchestrators in
 * lib/identity/drift/* call these primitives; provider-specific SQL lives
 * inside each adapter.
 *
 * Types are fully encapsulated — no raw Prisma rows leak out. Details that
 * appear in UI copy (e.g. orphan rows' `details` string) are composed by the
 * adapter.
 *
 * Lives in the shared submodule so the Bull worker's JML detection processor
 * can consume adapters too. Web-tree code re-exports from this module.
 */

import type { JmlScopeShape, ConnectionConfigShape } from '../../../lib/identity/drift/types.js';

export interface DirectoryUser {
  email: string;
  displayName: string;
  department: string | null;
  isActive: boolean;
}

export interface ProviderGroup {
  /**
   * Local database UUID (the `gws_groups` / `entra_groups` row ID).
   * Used as the React key and joined against `client_group_bindings.source_group_id`.
   */
  id: string;
  /**
   * Provider-side identifier (GWS group key, Entra group object ID).
   * Opaque to the orchestrator; surfaced for UI display only.
   */
  externalId: string;
  displayName: string;
  email: string | null;
  description: string | null;
  memberCount: number;
  isActive: boolean;
}

export interface FederationOrphan {
  email: string;
  /** Human-readable explanation the orchestrator will surface as drift.details. */
  details: string;
}

export interface FederatedSpaceDescriptor {
  /**
   * `true` when the adapter sees a configured federated space (GWS managed
   * OU set, or Entra federated domains non-empty). Orchestrators use this
   * to gate the orphan-detection path: when `false`, `findFederationOrphans`
   * will return an empty list and should typically not be called.
   *
   * Adapter implementers MUST treat missing, empty-string, and empty-array
   * config fields as "not configured" and return `false`.
   */
  readonly configured: boolean;
  /** Short label for UI ("Managed OU /Synthetic", "Federated domains: acme.com"). */
  readonly label: string;
}

export interface IdentityDriftAdapter {
  readonly pluginKey: string;

  // ── Directory users ──────────────────────────────────────────────────
  /**
   * Lookup directory users by exact email list (case-insensitive).
   * Returned `email` values preserve the casing stored by the provider —
   * callers normalize with `.toLowerCase()` when comparing across sets.
   */
  findDirectoryUsersByEmails(
    sourceId: string,
    agencyId: string,
    emails: string[],
  ): Promise<DirectoryUser[]>;

  /**
   * Fetch every directory user for this source. Used by the Users tab.
   * Drift computation needs the whole set in memory for O(1) lookups
   * against the JML-scope set and named-invite targets.
   * Returned `email` values preserve the casing stored by the provider —
   * callers normalize when comparing.
   */
  findAllDirectoryUsers(
    sourceId: string,
    agencyId: string,
  ): Promise<DirectoryUser[]>;

  // ── Groups ───────────────────────────────────────────────────────────
  /** Fetch every provider group for this source. Used by the Groups tab. */
  findGroups(
    sourceId: string,
    agencyId: string,
  ): Promise<ProviderGroup[]>;

  // ── JML scope resolution ─────────────────────────────────────────────
  /**
   * Resolve the scope to a concrete email set.
   *
   *   - returns Set<email lowercased> for scope modes this adapter handles
   *     (group, groups, org_units).
   *   - returns `null` for "everyone in the directory" modes
   *     (entire_org, entire_directory) — caller treats every directory
   *     user as in-scope.
   *   - returns an empty Set when the scope mode is valid but doesn't
   *     apply to this adapter (e.g. the Entra adapter receives
   *     'org_units', or the GWS adapter receives 'groups').
   */
  resolveJmlScopeEmails(
    sourceId: string,
    agencyId: string,
    scope: JmlScopeShape,
  ): Promise<Set<string> | null>;

  /**
   * Return the set of provider-group IDs referenced by this scope for
   * the groups' `inUse` computation. Pure function — no I/O.
   */
  resolveJmlScopeGroupIds(scope: JmlScopeShape): string[];

  // ── Federation (Identities tab only) ─────────────────────────────────
  /**
   * Return synthetic rows for provider users in the federated space that
   * are NOT already tracked as identities. `excludeEmails` is the set of
   * identity identifiers (lowercased) — orphans already matched by an
   * identity must be filtered out.
   */
  findFederationOrphans(
    sourceId: string,
    agencyId: string,
    cfg: ConnectionConfigShape,
    excludeEmails: Set<string>,
  ): Promise<FederationOrphan[]>;

  /** Whether a federated space is configured, and a label for UI. */
  describeFederatedSpace(cfg: ConnectionConfigShape): FederatedSpaceDescriptor;
}
