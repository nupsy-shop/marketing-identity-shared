/**
 * Entra ID Plugin Manifest
 *
 * Declares the Microsoft Graph application permissions required by this
 * plugin. These are configured as application permissions (not delegated)
 * in the Azure app registration and consented by a tenant admin.
 *
 * All scopes use the https://graph.microsoft.com/.default scope string
 * when requesting tokens via client_credentials flow (so the app gets
 * whatever permissions have been admin-consented). This list is the
 * canonical reference for:
 *   - Onboarding documentation
 *   - The re-consent OAuth flow in the web app
 *   - Operator-facing scope audits
 *
 * No @/ aliases — plain ESM with .js extensions.
 */

/**
 * Graph application permissions required by the Entra ID plugin.
 *
 * Add new scopes here when new Graph API capabilities are introduced.
 * Update docs/architecture/identity-sources/entra-id.md in the web repo
 * when this list changes.
 */
export const GRAPH_SCOPES = [
  // Core directory read access — user and group enumeration for sync
  'User.Read.All',
  'Group.Read.All',
  'GroupMember.Read.All',
  'Directory.Read.All',

  // User write access — create/update/suspend users and manage group membership
  'User.ReadWrite.All',
  'GroupMember.ReadWrite.All',

  // Audit log access — sign-in and directory activity polling
  'AuditLog.Read.All',

  // MFA enrollment tracking — reads /users/{id}/authentication/methods
  // Existing tenants must re-grant consent for this scope; new tenants
  // receive it automatically on first connect.
  'UserAuthenticationMethod.Read.All',
] as const;

export type GraphScope = (typeof GRAPH_SCOPES)[number];
