/**
 * Partner-invite email template — unit tests.
 *
 * Guards the message shape the `partner_invite_email` processor ships to the
 * shared email client: the accept URL must survive as `actionUrl`, the
 * event/severity must be the partner-invite constants, the title must name the
 * inviting agency, and the optional `contactName`/`note` fields must degrade
 * cleanly (no literal `undefined` leaking into the body).
 */
import { describe, it, expect } from '@jest/globals';

import { buildPartnerInviteEmail } from './partner-invite-template.js';

const baseCtx = {
  agencyName: 'Trevox Agency',
  partnerName: 'Northwind Partners',
  acceptUrl: 'https://app.accesshive.io/partners/accept/tok-abc',
  expiresAt: new Date('2026-06-12T00:00:00.000Z'),
};

describe('buildPartnerInviteEmail', () => {
  it('carries the accept URL through as actionUrl', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.actionUrl).toBe(baseCtx.acceptUrl);
  });

  it('uses the partner-invite event type and info severity', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.eventType).toBe('partner.invited');
    expect(msg.severity).toBe('info');
  });

  it('names the inviting agency in the title', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.title).toContain(baseCtx.agencyName);
  });

  it('includes the note when provided', () => {
    const msg = buildPartnerInviteEmail({ ...baseCtx, note: 'Looking forward to it' });
    expect(msg.body).toContain('Looking forward to it');
  });

  it('omits the note cleanly when absent — no literal "undefined" in the body', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.body).not.toContain('undefined');
  });

  it('greets the contact by name when contactName is provided', () => {
    const msg = buildPartnerInviteEmail({ ...baseCtx, contactName: 'Ada' });
    expect(msg.body).toContain('Hi Ada,');
  });

  it('skips the greeting (no stray "Hi ,") when contactName is absent', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.body).not.toContain('Hi ,');
  });

  it('renders the expiry as a UTC string', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.body).toContain(baseCtx.expiresAt.toUTCString());
  });

  it('exposes partner + agency names in metadata', () => {
    const msg = buildPartnerInviteEmail(baseCtx);
    expect(msg.metadata).toMatchObject({
      partnerName: baseCtx.partnerName,
      agencyName: baseCtx.agencyName,
    });
  });
});
