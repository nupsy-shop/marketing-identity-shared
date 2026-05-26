import { enqueueOperatorProvisioning } from '../provisionOperatorsToKeycloak';

jest.mock('@/lib/db/prisma', () => ({
  __esModule: true,
  default: {
    users: { findMany: jest.fn() },
    client_role_assignments: { findMany: jest.fn() },
  },
}));
jest.mock('@/lib/jobs/enqueue', () => ({
  enqueue: jest.fn().mockResolvedValue('job-123'),
}));

import prisma from '@/lib/db/prisma';
import { enqueue } from '@/lib/jobs/enqueue';

const mockedUsersFindMany = prisma.users.findMany as jest.Mock;
const mockedCraFindMany = prisma.client_role_assignments.findMany as jest.Mock;
const mockedEnqueue = enqueue as jest.Mock;

beforeEach(() => {
  jest.resetAllMocks();
  mockedEnqueue.mockResolvedValue('job-123');
});

test('queries admins and team members scoped by agency, dedup by id, enqueues one job each', async () => {
  mockedUsersFindMany
    .mockResolvedValueOnce([
      { id: 'u1', email: 'owner@ex.com', name: 'Ann Owner' },
      { id: 'u2', email: 'admin@ex.com', name: 'Bob Admin' },
    ])
    .mockResolvedValueOnce([
      { id: 'u3', email: 'member@ex.com', name: 'Cal Member' },
    ]);
  mockedCraFindMany.mockResolvedValueOnce([
    { app_user_id: 'u2' },  // already in admins → dedup
    { app_user_id: 'u3' },
  ]);

  const result = await enqueueOperatorProvisioning({
    agencyId: 'agency-1',
    realm: 'realm-a',
    triggeredBy: 'system',
  });

  expect(result).toEqual({ enqueued: 3, operators: 3 });
  expect(mockedUsersFindMany).toHaveBeenNthCalledWith(1, {
    where: {
      agency_id: 'agency-1',
      is_active: true,
      role: { in: ['agency_owner', 'agency_admin', 'ops_admin'] },
    },
    select: { id: true, email: true, name: true },
  });
  expect(mockedCraFindMany).toHaveBeenCalledWith({
    where: { agency_id: 'agency-1', is_active: true, role: 'client_team_member' },
    select: { app_user_id: true },
  });
  expect(mockedEnqueue).toHaveBeenCalledTimes(3);
  expect(mockedEnqueue).toHaveBeenCalledWith(
    'iam_provision_identity',
    expect.objectContaining({
      tenantId: 'agency-1',
      triggeredBy: 'system',
      realm: 'realm-a',
      email: 'owner@ex.com',
      firstName: 'Ann',
      lastName: 'Owner',
    }),
    { priority: 1, attempts: 5 },
  );
});

test('falls back to email local-part when name is missing', async () => {
  mockedUsersFindMany
    .mockResolvedValueOnce([{ id: 'u1', email: 'lone@ex.com', name: null }])
    .mockResolvedValueOnce([]);
  mockedCraFindMany.mockResolvedValueOnce([]);

  await enqueueOperatorProvisioning({ agencyId: 'a', realm: 'r', triggeredBy: 't' });

  expect(mockedEnqueue).toHaveBeenCalledWith(
    'iam_provision_identity',
    expect.objectContaining({ firstName: 'lone', lastName: 'User' }),
    { priority: 1, attempts: 5 },
  );
});

test('counts enqueued as 0 when enqueue returns null (queue unavailable)', async () => {
  mockedUsersFindMany
    .mockResolvedValueOnce([{ id: 'u1', email: 'x@ex.com', name: 'X Y' }])
    .mockResolvedValueOnce([]);
  mockedCraFindMany.mockResolvedValueOnce([]);
  mockedEnqueue.mockResolvedValueOnce(null);

  const result = await enqueueOperatorProvisioning({ agencyId: 'a', realm: 'r', triggeredBy: 't' });
  expect(result).toEqual({ enqueued: 0, operators: 1 });
});
