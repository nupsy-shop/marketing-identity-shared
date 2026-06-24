// Ensures a Keycloak user exists in the agency realm for a GWS synthetic
// identity and records the linkage on the integration_identities row. The
// Keycloak user's email is the GWS primaryEmail; the realm's Google SAML client
// already maps NameID = email, so a later impersonation of this user yields a
// Google login AS the synthetic identity. Idempotent: createKeycloakUser returns
// the existing user on 409, and an already-linked identity skips creation.

interface KeycloakUserLike {
  id: string;
  email?: string;
  [key: string]: unknown;
}

interface EnsureArgs {
  prisma: {
    integration_identities: {
      update: (args: { where: { id: string }; data: Record<string, unknown> }) => Promise<unknown>;
    };
  };
  createKeycloakUser: (
    user: { realm?: string; username?: string; email?: string; firstName?: string; lastName?: string },
    agencyId?: string,
  ) => Promise<KeycloakUserLike>;
  /** Optional: called with the resolved KC user ID after creation/lookup to add them to a group. */
  addToSyntheticGroup?: (userId: string) => Promise<void>;
  realm: string;
  agencyId: string;
  identityId: string;
  primaryEmail: string;
  givenName: string;
  familyName: string;
  existingKeycloakUserId?: string | null;
}

export async function ensureSyntheticKcUser(args: EnsureArgs): Promise<{ keycloakUserId: string }> {
  const { prisma, createKeycloakUser, realm, agencyId, identityId, primaryEmail, givenName, familyName } = args;
  if (!primaryEmail) {
    throw new Error('ensureSyntheticKcUser: primaryEmail is required to key a synthetic Keycloak user');
  }

  if (args.existingKeycloakUserId) {
    // Already linked — only enforce the identifier==primaryEmail correlation invariant.
    await prisma.integration_identities.update({
      where: { id: identityId },
      data: { identifier: primaryEmail, updatedAt: new Date() },
    });
    await args.addToSyntheticGroup?.(args.existingKeycloakUserId);
    return { keycloakUserId: args.existingKeycloakUserId };
  }

  const kcUser = await createKeycloakUser(
    // username is REQUIRED by the agency realm (createKeycloakUser passes the
    // payload straight to KC's POST /users, which 400s "User name is missing"
    // without it). The synthetic's email is its username — consistent with the
    // identifier==primaryEmail invariant and the realm's NameID=email mapping.
    { realm, username: primaryEmail, email: primaryEmail, firstName: givenName, lastName: familyName },
    agencyId,
  );

  await prisma.integration_identities.update({
    where: { id: identityId },
    data: { keycloak_user_id: kcUser.id, identifier: primaryEmail, updatedAt: new Date() },
  });

  await args.addToSyntheticGroup?.(kcUser.id);
  return { keycloakUserId: kcUser.id };
}
