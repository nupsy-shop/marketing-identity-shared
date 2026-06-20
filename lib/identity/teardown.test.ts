// Unit test for the agencyId-forwarding contract in
// `teardownIdpForIdentity` (issue #1072 / closes the failed-delete path
// gap surfaced by #1071).
//
// What this guards: the helper MUST pass `identity.agency_id` as the
// trailing argument to `deleteKeycloakUser`, which in turn forwards it to
// `adminFetch` where the provider-override resolver fires. Without that
// forward, the override hook can never short-circuit on the teardown code
// path — see #1072 for the failed-delete BDD scenario that depends on
// this.
//
// The test mocks `deleteKeycloakUser` and asserts the call signature; the
// provider-override hook itself is covered exhaustively in
// `marketing-identity/tests/unit/keycloak/adminFetch-override.test.ts`.

import { jest } from '@jest/globals';

const deleteKeycloakUserMock = jest.fn<
  (realm: string, userId: string, agencyId?: string) => Promise<void>
>();

jest.mock('../keycloakAdmin.js', () => ({
  deleteKeycloakUser: deleteKeycloakUserMock,
}));

import { teardownIdpForIdentity } from './teardown.js';

const mockPrisma = {
  agency_settings: {
    findFirst: jest.fn<
      (args: unknown) => Promise<{ keycloak_realm: string | null } | null>
    >(),
  },
  local_directory_users: {
    count: jest.fn<(args: unknown) => Promise<number>>(),
  },
  integration_identities: {
    count: jest.fn<(args: unknown) => Promise<number>>(),
  },
};

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

beforeEach(() => {
  deleteKeycloakUserMock.mockReset();
  mockPrisma.agency_settings.findFirst.mockReset();
  mockPrisma.local_directory_users.count.mockReset();
  mockPrisma.integration_identities.count.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
  // Default: the identity solely owns its Keycloak user (no other referrers).
  mockPrisma.local_directory_users.count.mockResolvedValue(0);
  mockPrisma.integration_identities.count.mockResolvedValue(0);
});

describe('teardownIdpForIdentity — agencyId forwarding (issue #1072)', () => {
  it('forwards identity.agency_id as the 3rd arg to deleteKeycloakUser', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });
    deleteKeycloakUserMock.mockResolvedValue(undefined);

    await teardownIdpForIdentity(
      { id: 'identity-1', agency_id: 'agency-trevox', keycloak_user_id: 'kc-user-1' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).toHaveBeenCalledTimes(1);
    expect(deleteKeycloakUserMock).toHaveBeenCalledWith('realm-1', 'kc-user-1', 'agency-trevox');
  });

  it('skips upstream call (and thus does not invoke deleteKeycloakUser at all) when keycloak_user_id is null', async () => {
    await teardownIdpForIdentity(
      { id: 'identity-2', agency_id: 'agency-trevox', keycloak_user_id: null },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).not.toHaveBeenCalled();
    expect(mockPrisma.agency_settings.findFirst).not.toHaveBeenCalled();
  });

  it('skips upstream call when the agency has no keycloak_realm', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: null });

    await teardownIdpForIdentity(
      { id: 'identity-3', agency_id: 'agency-no-realm', keycloak_user_id: 'kc-user-3' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).not.toHaveBeenCalled();
  });

  it('still forwards agency_id even when the upstream delete throws (so an override can force a 500 for #1071)', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });
    deleteKeycloakUserMock.mockRejectedValue(new Error('boom 500'));

    await expect(
      teardownIdpForIdentity(
        { id: 'identity-4', agency_id: 'agency-trevox', keycloak_user_id: 'kc-user-4' },
        { prisma: mockPrisma as never, logger: mockLogger },
      ),
    ).rejects.toThrow(/Keycloak user delete failed/);

    expect(deleteKeycloakUserMock).toHaveBeenCalledWith('realm-1', 'kc-user-4', 'agency-trevox');
  });
});

describe('teardownIdpForIdentity — shared-ownership guard (defense in depth)', () => {
  it('skips the Keycloak delete when a local_directory_users row shares the keycloak_user_id (protects real/persona SSO accounts)', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });
    // A persona / real human account is backed by a local_directory_users row
    // pointing at this same KC user — the ephemeral identity inherited it via
    // createKeycloakUser's 409-by-email idempotency.
    mockPrisma.local_directory_users.count.mockResolvedValue(1);

    await teardownIdpForIdentity(
      { id: 'ephemeral-1', agency_id: 'agency-trevox', keycloak_user_id: 'persona-kc-user' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('skips the Keycloak delete when another integration_identities row still references the keycloak_user_id (shared dedicated reuse)', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });
    mockPrisma.integration_identities.count.mockResolvedValue(1);

    await teardownIdpForIdentity(
      { id: 'dedicated-a', agency_id: 'agency-trevox', keycloak_user_id: 'shared-dedicated-kc' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).not.toHaveBeenCalled();
  });

  it('excludes the identity being torn down from the other-identity ownership check', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });

    await teardownIdpForIdentity(
      { id: 'identity-9', agency_id: 'agency-trevox', keycloak_user_id: 'kc-user-9' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(mockPrisma.integration_identities.count).toHaveBeenCalledWith({
      where: {
        agency_id: 'agency-trevox',
        keycloak_user_id: 'kc-user-9',
        NOT: { id: 'identity-9' },
      },
    });
    // Sole owner (counts default 0) → delete proceeds.
    expect(deleteKeycloakUserMock).toHaveBeenCalledWith('realm-1', 'kc-user-9', 'agency-trevox');
  });

  it('fails closed: skips the Keycloak delete when the ownership check itself throws', async () => {
    mockPrisma.agency_settings.findFirst.mockResolvedValue({ keycloak_realm: 'realm-1' });
    mockPrisma.local_directory_users.count.mockRejectedValue(new Error('db down'));

    await teardownIdpForIdentity(
      { id: 'identity-10', agency_id: 'agency-trevox', keycloak_user_id: 'kc-user-10' },
      { prisma: mockPrisma as never, logger: mockLogger },
    );

    expect(deleteKeycloakUserMock).not.toHaveBeenCalled();
  });
});
