/**
 * Partner-invite email template.
 *
 * Builds the `EmailNotificationMessage` for the `partner_invite_email` job:
 * a partner-org collaboration invite linking to the public accept page. The
 * accept URL is carried as `actionUrl` so the shared email client renders the
 * "View in AccessHive" CTA button against it.
 *
 * Optional context (`contactName`, `note`) degrades cleanly — an absent
 * contact name drops the greeting entirely (rather than emitting `Hi ,`) and an
 * absent note adds no quoted block, so no literal `undefined` ever lands in the
 * rendered body.
 */
import type { EmailNotificationMessage } from './client.js';

export interface PartnerInviteEmailCtx {
  agencyName: string;
  partnerName: string;
  contactName?: string | null;
  note?: string | null;
  acceptUrl: string;
  expiresAt: Date;
}

export function buildPartnerInviteEmail(ctx: PartnerInviteEmailCtx): EmailNotificationMessage {
  const greeting = ctx.contactName ? `Hi ${ctx.contactName},\n\n` : '';
  const noteBlock = ctx.note ? `\n\n"${ctx.note}"` : '';

  const body =
    greeting +
    `${ctx.agencyName} has invited ${ctx.partnerName} to collaborate with scoped access to their clients.` +
    noteBlock +
    `\n\nUse the button below to accept your invitation. This link expires on ${ctx.expiresAt.toUTCString()}.`;

  return {
    title: `You've been invited to ${ctx.agencyName} on AccessHive`,
    body,
    severity: 'info',
    eventType: 'partner.invited',
    timestamp: new Date().toISOString(),
    actionUrl: ctx.acceptUrl,
    metadata: { partnerName: ctx.partnerName, agencyName: ctx.agencyName },
  };
}
