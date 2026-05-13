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
};

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

beforeEach(() => {
  deleteKeycloakUserMock.mockReset();
  mockPrisma.agency_settings.findFirst.mockReset();
  mockLogger.debug.mockReset();
  mockLogger.warn.mockReset();
  mockLogger.error.mockReset();
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
