/**
 * `partner_invite_email` processor — unit tests.
 *
 * Mirrors the failure taxonomy of `email_send`: provider 4xx (and 501) is a
 * terminal `failed` return (no Bull retry), provider 5xx / network throws so
 * Bull retries, and config/lifecycle gaps (missing invite, non-pending invite,
 * unconfigured base URL) short-circuit to `skipped`/`failed` without sending.
 *
 * prisma is reached through `getRuntime()` (the shared runtime service
 * locator), so the runtime module is mocked rather than a prisma default
 * import — matching `email-send.ts`.
 */
import { jest } from '@jest/globals';

const findFirstMock = jest.fn<(args: unknown) => Promise<unknown>>();
const sendEmailMessageMock = jest.fn<
  (...args: unknown[]) => Promise<{ ok: boolean; status: number; error?: string }>
>();
const recordTestDispatchMock = jest.fn<(...args: unknown[]) => Promise<void>>();

jest.mock('../../../../lib/runtime.js', () => ({
  getRuntime: () => ({
    prisma: { partner_invites: { findFirst: findFirstMock } },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  }),
}));

jest.mock('../client.js', () => ({
  sendEmailMessage: sendEmailMessageMock,
}));

jest.mock('../../../../lib/notifications/dispatch-capture.js', () => ({
  recordTestDispatch: recordTestDispatchMock,
}));

import partnerInviteEmail from './partner-invite-email.js';

const AGENCY = '00000000-0000-0000-0000-0000000000aa';
const INVITE = '00000000-0000-0000-0000-0000000000bb';
const fakeJob = (data: Record<string, unknown>) => ({ id: 'job-1', data } as never);

const pendingInvite = {
  token: 'tok-xyz',
  email: 'partner@example.com',
  status: 'pending',
  note: 'Welcome aboard',
  expires_at: new Date('2026-06-12T00:00:00.000Z'),
  partners: { name: 'Northwind Partners', primary_contact_name: 'Ada' },
  agencies: { name: 'Trevox Agency' },
};

beforeEach(() => {
  findFirstMock.mockReset();
  sendEmailMessageMock.mockReset();
  recordTestDispatchMock.mockReset().mockResolvedValue(undefined);
  process.env.NEXT_PUBLIC_BASE_URL = 'https://app.accesshive.io';
  delete process.env.OAUTH_REDIRECT_BASE_URL;
});

describe('partner_invite_email processor', () => {
  it('builds the accept URL from baseUrl + token and completes on ok:true (202)', async () => {
    findFirstMock.mockResolvedValue(pendingInvite);
    sendEmailMessageMock.mockResolvedValue({ ok: true, status: 202 });

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('completed');
    expect(out.jobType).toBe('partner_invite_email');
    expect(out.deliveryStatus).toBe(202);

    const message = sendEmailMessageMock.mock.calls[0][2] as { actionUrl: string };
    expect(message.actionUrl).toBe('https://app.accesshive.io/partners/accept/tok-xyz');
  });

  it('records a test dispatch as delivered on success', async () => {
    findFirstMock.mockResolvedValue(pendingInvite);
    sendEmailMessageMock.mockResolvedValue({ ok: true, status: 202 });

    await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(recordTestDispatchMock).toHaveBeenCalledTimes(1);
    const arg = recordTestDispatchMock.mock.calls[0][0] as { status: string; eventType: string };
    expect(arg.status).toBe('delivered');
    expect(arg.eventType).toBe('partner.invited');
  });

  it('returns failed (no throw) on a provider 4xx', async () => {
    findFirstMock.mockResolvedValue(pendingInvite);
    sendEmailMessageMock.mockResolvedValue({ ok: false, status: 400, error: 'bad recipients' });

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('failed');
    expect(out.deliveryStatus).toBe(400);
  });

  it('returns failed (no throw) on 501', async () => {
    findFirstMock.mockResolvedValue(pendingInvite);
    sendEmailMessageMock.mockResolvedValue({ ok: false, status: 501, error: 'ses not impl' });

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('failed');
  });

  it('throws on a provider 5xx so Bull retries', async () => {
    findFirstMock.mockResolvedValue(pendingInvite);
    sendEmailMessageMock.mockResolvedValue({ ok: false, status: 503, error: 'upstream down' });

    await expect(
      partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE })),
    ).rejects.toThrow();
  });

  it('skips when the invite is missing', async () => {
    findFirstMock.mockResolvedValue(null);

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('skipped');
    expect(sendEmailMessageMock).not.toHaveBeenCalled();
  });

  it('skips when the invite is not pending', async () => {
    findFirstMock.mockResolvedValue({ ...pendingInvite, status: 'revoked' });

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('skipped');
    expect(sendEmailMessageMock).not.toHaveBeenCalled();
  });

  it('returns failed when no base URL is configured', async () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    delete process.env.OAUTH_REDIRECT_BASE_URL;
    findFirstMock.mockResolvedValue(pendingInvite);

    const out = await partnerInviteEmail(fakeJob({ agencyId: AGENCY, inviteId: INVITE }));

    expect(out.status).toBe('failed');
    expect(sendEmailMessageMock).not.toHaveBeenCalled();
  });
});
