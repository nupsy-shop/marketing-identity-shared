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
  /**
   * Optional: heal an EXISTING KC user's standard profile (email/name). A synthetic
   * recreated/incompletely-provisioned can have a username but no email/name, which
   * excludes it from the PAM chooser and yields an empty SAML NameID (#2312). When
   * provided, the existing-user branch repairs those fields.
   */
  updateKeycloakUser?: (
    userId: string,
    profile: { email?: string; emailVerified?: boolean; firstName?: string; lastName?: string },
    realm: string,
  ) => Promise<unknown>;
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
    // Already linked — enforce the identifier==primaryEmail correlation invariant.
    await prisma.integration_identities.update({
      where: { id: identityId },
      data: { identifier: primaryEmail, updatedAt: new Date() },
    });
    // Heal the KC user profile so it is present in the chooser and yields a valid
    // SAML NameID (recreated/incompletely-provisioned users can lack email/name).
    if (args.updateKeycloakUser) {
      await args.updateKeycloakUser(
        args.existingKeycloakUserId,
        { email: primaryEmail, emailVerified: true, firstName: givenName, lastName: familyName },
        realm,
      );
    }
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
