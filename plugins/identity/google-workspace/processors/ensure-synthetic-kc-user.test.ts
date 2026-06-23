import { describe, it, expect, vi } from 'vitest';
import { ensureSyntheticKcUser } from './ensure-synthetic-kc-user.js';

function makePrisma() {
  return {
    integration_identities: { update: vi.fn().mockResolvedValue({}) },
  } as any;
}

describe('ensureSyntheticKcUser', () => {
  it('creates a KC user (realm+email+name) and persists keycloak_user_id + identifier', async () => {
    const prisma = makePrisma();
    const createKeycloakUser = vi.fn().mockResolvedValue({ id: 'kc-9', email: 'syn@trevox.agency' });
    const addToSyntheticGroup = vi.fn().mockResolvedValue(undefined);

    const out = await ensureSyntheticKcUser({
      prisma,
      createKeycloakUser,
      addToSyntheticGroup,
      realm: 'agency-trevox',
      agencyId: 'ag-1',
      identityId: 'idy-1',
      primaryEmail: 'syn@trevox.agency',
      givenName: 'PAM',
      familyName: 'Synthetic',
    });

    expect(createKeycloakUser).toHaveBeenCalledWith(
      { realm: 'agency-trevox', email: 'syn@trevox.agency', firstName: 'PAM', lastName: 'Synthetic' },
      'ag-1',
    );
    expect(prisma.integration_identities.update).toHaveBeenCalledWith({
      where: { id: 'idy-1' },
      data: { keycloak_user_id: 'kc-9', identifier: 'syn@trevox.agency', updatedAt: expect.any(Date) },
    });
    expect(addToSyntheticGroup).toHaveBeenCalledWith('kc-9');
    expect(out).toEqual({ keycloakUserId: 'kc-9' });
  });

  it('is idempotent: skips creation when keycloakUserId already present, still enforces identifier', async () => {
    const prisma = makePrisma();
    const createKeycloakUser = vi.fn();
    const addToSyntheticGroup = vi.fn().mockResolvedValue(undefined);
    const out = await ensureSyntheticKcUser({
      prisma, createKeycloakUser, addToSyntheticGroup, realm: 'agency-trevox', agencyId: 'ag-1', identityId: 'idy-1',
      primaryEmail: 'syn@trevox.agency', givenName: 'PAM', familyName: 'Synthetic',
      existingKeycloakUserId: 'kc-existing',
    });
    expect(createKeycloakUser).not.toHaveBeenCalled();
    expect(prisma.integration_identities.update).toHaveBeenCalledWith({
      where: { id: 'idy-1' },
      data: { identifier: 'syn@trevox.agency', updatedAt: expect.any(Date) },
    });
    expect(addToSyntheticGroup).toHaveBeenCalledWith('kc-existing');
    expect(out).toEqual({ keycloakUserId: 'kc-existing' });
  });

  it('throws if primaryEmail is missing (cannot key a synthetic KC user)', async () => {
    const prisma = makePrisma();
    await expect(
      ensureSyntheticKcUser({
        prisma, createKeycloakUser: vi.fn(), realm: 'agency-trevox', agencyId: 'ag-1',
        identityId: 'idy-1', primaryEmail: '', givenName: 'PAM', familyName: 'Synthetic',
      }),
    ).rejects.toThrow(/primaryEmail/);
  });
});
