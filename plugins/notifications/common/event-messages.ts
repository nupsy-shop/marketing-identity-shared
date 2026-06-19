/**
 * Maps event types to human-readable notification messages.
 *
 * Each plugin's sender receives the output of this function and formats
 * it into the channel's native representation (Slack blocks, HTML email,
 * Adaptive Card, JSON payload).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

interface SeverityInfo {
  label: string;
  color: string;
}

interface EventMessage {
  title: string;
  body: string;
  severity: string;
}

interface EventContext {
  actor?: string;
  role?: string;
  platform?: string;
  client?: string;
  approver?: string;
  reason?: string;
  identity?: string;
  daysRemaining?: number | string;
  // access.expiration.expiring — pre-expiry notifier context (IDs + timestamps only).
  itemId?: string;
  clientId?: string;
  platformKey?: string;
  expiresAt?: string;
  daysAhead?: number;
  admin?: string;
  description?: string;
  user?: string;
  source?: string;
  action?: string;
  previousRole?: string;
  newRole?: string;
  error?: string;
  usersAdded?: number;
  usersRemoved?: number;
  errorCount?: number;
  firstError?: string;
  planName?: string;
  newPlan?: string;
  channelName?: string;
  pluginKey?: string;
  eventType?: string;
  channelCount?: number;
  // Campaign-scoped access (issue #60). Payloads carry IDs + keys only.
  campaignId?: string;
  campaignName?: string;
  memberUserId?: string;
  memberCount?: number;
  roleTemplateKey?: string;
  endsAt?: string;
  // Recurring access windows (issue #56) — platformKey already declared above
  stage?: string;
  // Recurring access windows (issue #56)
  grantId?: string;
  windowStart?: string;
  windowEnd?: string;
  scheduleSummary?: string;
  previousRrule?: string;
  newRrule?: string;
  // provisioning.template.apply.* (issue #61) — one-click multi-platform provisioning.
  // roleTemplateKey already declared above in the campaign block.
  userId?: string;
  platformCount?: number;
  durationMs?: number;
  errorKind?: string;
  status?: string;
  okCount?: number;
  failedCount?: number;
  totalDurationMs?: number;
  // Client onboarding kit (issue #62) — failedCount already declared above.
  kitKey?: string;
  kitName?: string;
  stepName?: string;
  teamMemberCount?: number;
  provisionedCount?: number;
  welcomeCount?: number;
  // Partner Hub access (issue #63) — IDs + role bundle only, no credentials.
  agencyId?: string;
  partnerId?: string;
  partnerName?: string;
  partnerUserId?: string;
  roleBundle?: string;
  activePartners?: number;
  linkedClients?: number;
  lastReviewAt?: string;
}

interface EventSubscriptionEvent {
  pattern: string;
  label: string;
}

interface EventSubscriptionCategory {
  key: string;
  label: string;
  description: string;
  events: EventSubscriptionEvent[];
}

const SEVERITY_MAP: Record<string, SeverityInfo> = {
  info:     { label: 'Info',     color: '#3B82F6' },
  warning:  { label: 'Warning',  color: '#F59E0B' },
  critical: { label: 'Critical', color: '#EF4444' },
};

export function formatEventMessage(eventType: string, context: EventContext = {}): EventMessage {
  const ctx = context || {};
  const safe = (val: string | number | undefined): string => (val != null ? String(val) : 'Unknown');

  const MESSAGES: Record<string, EventMessage> = {
    // ── Access Management ─────────────────────────────────────────
    'access.request.created': {
      title: 'New Access Request',
      body: `${safe(ctx.actor)} requested ${safe(ctx.role)} access to ${safe(ctx.platform)} for ${safe(ctx.client)}.`,
      severity: 'info',
    },
    'access.request.approved': {
      title: 'Access Request Approved',
      body: `${safe(ctx.approver)} approved ${safe(ctx.actor)}'s request for ${safe(ctx.platform)}.`,
      severity: 'info',
    },
    'access.request.denied': {
      title: 'Access Request Denied',
      body: `${safe(ctx.approver)} denied ${safe(ctx.actor)}'s request for ${safe(ctx.platform)}. Reason: ${ctx.reason || 'Not specified'}.`,
      severity: 'warning',
    },
    'access.request.completed': {
      title: 'Access Provisioning Complete',
      body: `Access to ${safe(ctx.platform)} for ${safe(ctx.client)} has been provisioned successfully.`,
      severity: 'info',
    },
    'access.verification.validated': {
      title: 'Access Verified',
      body: `Access for ${safe(ctx.identity)} on ${safe(ctx.platform)} has been verified.`,
      severity: 'info',
    },
    'access.verification.failed': {
      title: 'Access Verification Failed',
      body: `Verification failed for ${safe(ctx.identity)} on ${safe(ctx.platform)}: ${safe(ctx.reason)}.`,
      severity: 'warning',
    },
    // Fired by scripts/pre-expiry-notifier.ts. Context is strictly
    // IDs + timestamps — no seed values, backup codes, passwords, or grant
    // bodies. See docs/features/pre-expiry-notifications/CLAUDE.md.
    'access.expiration.expiring': {
      title: `Access expiring in ${ctx.daysAhead ?? '?'} day(s) — ${safe(ctx.platformKey)}`,
      body: `Access item ${safe(ctx.itemId)} for client ${safe(ctx.clientId)} on ${safe(ctx.platformKey)} expires at ${safe(ctx.expiresAt)} (in ${ctx.daysAhead ?? '?'} day(s)). Review or renew it before the expiry window closes.`,
      severity: 'warning',
    },
    'access.expiration.expired': {
      title: 'Access Expired',
      body: `${safe(ctx.identity)}'s access to ${safe(ctx.platform)} has expired and been revoked.`,
      severity: 'warning',
    },

    // ── Contractor management (issue #55) ────────────────────────
    // Payloads carry IDs + dates only — never PII, never agreement body.
    'directory.user.contract_updated': {
      title: 'Contractor contract updated',
      body: `Contractor ${safe((ctx as Record<string, unknown>).userId as string)} contract fields were updated by ${safe((ctx as Record<string, unknown>).operatorId as string)}.`,
      severity: 'info',
    },
    'directory.user.contract_renewed': {
      title: 'Contractor contract renewed',
      body: `Contractor ${safe((ctx as Record<string, unknown>).userId as string)} was renewed by ${safe((ctx as Record<string, unknown>).operatorId as string)} (+${safe((ctx as Record<string, unknown>).extensionDays as number)} days, new end ${safe((ctx as Record<string, unknown>).newEndAt as string)}).`,
      severity: 'info',
    },
    'directory.user.contract_expiring': {
      title: `Contractor expiring in ${(ctx as Record<string, unknown>).thresholdDays ?? '?'} day(s)`,
      body: `Contractor ${safe((ctx as Record<string, unknown>).userId as string)} contract ends at ${safe((ctx as Record<string, unknown>).contractEndAt as string)} (in ${(ctx as Record<string, unknown>).thresholdDays ?? '?'} day(s)).`,
      severity: 'warning',
    },
    'directory.user.contract_expired': {
      title: 'Contractor contract expired',
      body: `Contractor ${safe((ctx as Record<string, unknown>).userId as string)} contract has lapsed. ${(ctx as Record<string, unknown>).autoOffboard === false ? 'Manual review required.' : 'Auto-offboarding via JML leaver.'}`,
      severity: 'warning',
    },

    // ── Recurring access windows (issue #56) ──────────────────────
    'access.window.activated': {
      title: 'Access Window Activated',
      body: `First access window opened for ${safe(ctx.platformKey)} grant ${safe(ctx.grantId)}. Schedule: ${safe(ctx.scheduleSummary)}.`,
      severity: 'info',
    },
    'access.window.opened': {
      title: 'Access Window Opened',
      body: `Access window opened for ${safe(ctx.platformKey)} grant ${safe(ctx.grantId)} at ${safe(ctx.windowStart)}.`,
      severity: 'info',
    },
    'access.window.closed': {
      title: 'Access Window Closed',
      body: `Access window closed for ${safe(ctx.platformKey)} grant ${safe(ctx.grantId)} at ${safe(ctx.windowEnd)}.`,
      severity: 'info',
    },
    'access.schedule_updated': {
      title: 'Access Schedule Updated',
      body: `${safe(ctx.actor)} updated the schedule for grant ${safe(ctx.grantId)}. New: ${safe(ctx.newRrule)}.`,
      severity: 'info',
    },

    // ── Campaign-scoped access (issue #60) ────────────────────────
    'campaign.created': {
      title: 'Campaign Created',
      body: `Campaign "${safe(ctx.campaignName)}" created (ends ${safe(ctx.endsAt)}).`,
      severity: 'info',
    },
    'campaign.members.added': {
      title: 'Campaign Members Added',
      body: `${ctx.memberCount || 0} member(s) added to campaign "${safe(ctx.campaignName)}".`,
      severity: 'info',
    },
    'campaign.member.added': {
      title: 'Campaign Member Added',
      body: `User ${safe(ctx.memberUserId)} added to campaign "${safe(ctx.campaignName)}".`,
      severity: 'info',
    },
    'campaign.member.removed': {
      title: 'Campaign Member Removed',
      body: `User ${safe(ctx.memberUserId)} removed from campaign "${safe(ctx.campaignName)}".`,
      severity: 'info',
    },
    'campaign.ended': {
      title: 'Campaign Ended',
      body: `Campaign "${safe(ctx.campaignName)}" has ended. Campaign-scoped grants are being revoked.`,
      severity: 'info',
    },
    'campaign.member.revoked': {
      title: 'Campaign Member Access Revoked',
      body: `Campaign-scoped grants for user ${safe(ctx.memberUserId)} on ${safe(ctx.platformKey)} were revoked.`,
      severity: 'info',
    },
    'campaign.member.revoked_error': {
      title: 'Campaign Member Revoke Failed',
      body: `Failed to revoke campaign-scoped grants for user ${safe(ctx.memberUserId)}: ${safe(ctx.error)}.`,
      severity: 'warning',
    },

    // ── Security ──────────────────────────────────────────────────
    'pam.session.checkout': {
      title: 'PAM Credential Checkout',
      body: `${safe(ctx.actor)} checked out credentials for ${safe(ctx.platform)} (${safe(ctx.identity)}).`,
      severity: 'info',
    },
    'pam.session.checkin': {
      title: 'PAM Credential Check-In',
      body: `${safe(ctx.actor)} checked in credentials for ${safe(ctx.platform)}.`,
      severity: 'info',
    },
    'pam.session.force_terminate': {
      title: 'PAM Session Force Terminated',
      body: `Admin ${safe(ctx.admin)} force-terminated ${safe(ctx.actor)}'s PAM session on ${safe(ctx.platform)}.`,
      severity: 'critical',
    },
    'drift.detected': {
      title: 'Access Drift Detected',
      body: `Unauthorized access found on ${safe(ctx.platform)}: ${safe(ctx.description)}.`,
      severity: 'critical',
    },
    'drift.resolved': {
      title: 'Access Drift Resolved',
      body: `Drift on ${safe(ctx.platform)} has been resolved: ${safe(ctx.description)}.`,
      severity: 'info',
    },
    'emergency_access.reveal.requested': {
      title: 'Break-glass reveal requested',
      body: 'A break-glass credential reveal was requested and needs your decision. Open the request to approve or deny.',
      severity: 'warning',
    },
    'emergency_access.reveal.approved': {
      title: 'Break-glass reveal approved',
      body: 'Your break-glass credential reveal request was approved.',
      severity: 'info',
    },
    'emergency_access.reveal.denied': {
      title: 'Break-glass reveal denied',
      body: 'Your break-glass credential reveal request was denied.',
      severity: 'warning',
    },
    'breakglass.credential.revealed': {
      title: 'Break-Glass Credential Revealed',
      body: `${safe(ctx.actor)} revealed break-glass credentials for ${safe(ctx.platform)}.`,
      severity: 'critical',
    },
    'sod.violation.detected': {
      title: 'SoD Violation Detected',
      body: `Separation of duties conflict: ${safe(ctx.description)}.`,
      severity: 'critical',
    },

    // ── Identity Lifecycle ────────────────────────────────────────
    'jml.joiner.detected': {
      title: 'New Employee Detected',
      body: `${safe(ctx.user)} was created in ${safe(ctx.source)}. Provisioning ${safe(ctx.action)}.`,
      severity: 'info',
    },
    'jml.mover.detected': {
      title: 'Employee Role Change Detected',
      body: `${safe(ctx.user)} changed from ${safe(ctx.previousRole)} to ${safe(ctx.newRole)} in ${safe(ctx.source)}.`,
      severity: 'warning',
    },
    'jml.leaver.detected': {
      title: 'Employee Offboarding Detected',
      body: `${safe(ctx.user)} was deactivated in ${safe(ctx.source)}. Access revocation ${safe(ctx.action)}.`,
      severity: 'warning',
    },
    'identity.provisioning.created': {
      title: 'Identity Provisioned',
      body: `Identity ${safe(ctx.identity)} provisioned on ${safe(ctx.platform)}.`,
      severity: 'info',
    },
    'identity.provisioning.failed': {
      title: 'Identity Provisioning Failed',
      body: `Failed to provision ${safe(ctx.identity)} on ${safe(ctx.platform)}: ${safe(ctx.error)}.`,
      severity: 'critical',
    },
    'provisioning.template.apply.started': {
      title: 'Apply Role Template Started',
      body: `Applying template ${safe(ctx.roleTemplateKey)} to user ${safe(ctx.userId)} across ${ctx.platformCount || 0} platform(s).`,
      severity: 'info',
    },
    'provisioning.template.apply.platform.ok': {
      title: 'Template Platform Granted',
      body: `Granted ${safe(ctx.platformKey)} for template ${safe(ctx.roleTemplateKey)} in ${ctx.durationMs || 0}ms.`,
      severity: 'info',
    },
    'provisioning.template.apply.platform.failed': {
      title: 'Template Platform Grant Failed',
      body: `Failed to grant ${safe(ctx.platformKey)} for template ${safe(ctx.roleTemplateKey)} (${safe(ctx.errorKind)}) after ${ctx.durationMs || 0}ms.`,
      severity: 'warning',
    },
    'provisioning.template.apply.completed': {
      title: 'Apply Role Template Completed',
      body: `Template ${safe(ctx.roleTemplateKey)} applied with status ${safe(ctx.status)}: ${ctx.okCount || 0} ok, ${ctx.failedCount || 0} failed in ${ctx.totalDurationMs || 0}ms.`,
      severity: 'info',
    },
    'directory.sync.completed': {
      title: 'Directory Sync Complete',
      body: `${safe(ctx.source)} sync completed: ${ctx.usersAdded || 0} added, ${ctx.usersRemoved || 0} removed.`,
      severity: 'info',
    },
    'directory.sync.errors': {
      title: 'Directory Sync Errors',
      body: `${safe(ctx.source)} sync encountered ${ctx.errorCount || 0} error(s): ${safe(ctx.firstError)}.`,
      severity: 'warning',
    },

    // ── Client Trust Reports ──────────────────────────────────────
    'client.trust_report.generated': {
      title: 'Trust Report Generated',
      body: `Quarterly trust report for ${safe(ctx.client)} is ready.`,
      severity: 'info',
    },
    'client.trust_report.delivered': {
      title: 'Trust Report Delivered',
      body: `Quarterly trust report for ${safe(ctx.client)} delivered to subscribed contacts.`,
      severity: 'info',
    },
    'client.trust_report.failed': {
      title: 'Trust Report Failed',
      body: `Trust report for ${safe(ctx.client)} failed at stage ${safe(ctx.stage)}: ${safe(ctx.reason)}.`,
      severity: 'warning',
    },
    'client.trust_report.subscribed': {
      title: 'Trust Report Schedule Updated',
      body: `Trust report schedule for ${safe(ctx.client)} was updated by ${safe(ctx.actor)}.`,
      severity: 'info',
    },

    'identity.source.degraded': {
      title: 'Identity Source Degraded',
      body: `${safe(ctx.source)} health transitioned to ${safe((ctx as Record<string, unknown>).newState as string)} (was ${safe((ctx as Record<string, unknown>).previousState as string)}).`,
      severity: 'warning',
    },
    'identity.source.restored': {
      title: 'Identity Source Restored',
      body: `${safe(ctx.source)} is back to connected (was ${safe((ctx as Record<string, unknown>).previousState as string)}).`,
      severity: 'info',
    },

    // ── System ────────────────────────────────────────────────────
    'siem.forwarding.error': {
      title: 'SIEM Forwarding Error',
      body: `Failed to forward events to SIEM: ${safe(ctx.error)}.`,
      severity: 'critical',
    },
    'billing.payment.failed': {
      title: 'Payment Failed',
      body: `Payment for ${safe(ctx.planName)} failed: ${safe(ctx.reason)}.`,
      severity: 'critical',
    },
    'billing.upgrade.completed': {
      title: 'Plan Upgraded',
      body: `Agency plan upgraded to ${safe(ctx.newPlan)}.`,
      severity: 'info',
    },

    // ── Notification channel lifecycle ────────────────────────────
    'notification.channel.created': {
      title: 'Notification Channel Created',
      body: `Channel "${safe(ctx.channelName)}" (${safe(ctx.pluginKey)}) was created.`,
      severity: 'info',
    },
    'notification.channel.updated': {
      title: 'Notification Channel Updated',
      body: `Channel "${safe(ctx.channelName)}" was updated.`,
      severity: 'info',
    },
    'notification.channel.deleted': {
      title: 'Notification Channel Deleted',
      body: `Channel "${safe(ctx.channelName)}" was deleted.`,
      severity: 'info',
    },
    'notification.channel.tested': {
      title: 'Notification Channel Tested',
      body: `Test message sent to "${safe(ctx.channelName)}".`,
      severity: 'info',
    },
    'notification.dispatched': {
      title: 'Notification Dispatched',
      body: `Notification for ${safe(ctx.eventType)} dispatched to ${ctx.channelCount || 0} channel(s).`,
      severity: 'info',
    },
    'notification.failed': {
      title: 'Notification Delivery Failed',
      body: `Failed to deliver notification to "${safe(ctx.channelName)}": ${safe(ctx.error)}.`,
      severity: 'warning',
    },

    // ── Access analytics (issue #59) ──────────────────────────────
    // Payloads carry agencyId + counts ONLY — never user emails or grant IDs.
    'analytics.snapshot.refreshed': {
      title: 'Access Analytics Refreshed',
      body: `Hourly access-analytics snapshot refreshed (${(ctx as Record<string, unknown>).cellCount ?? 0} cells, ${(ctx as Record<string, unknown>).trendDays ?? 90} days).`,
      severity: 'info',
    },
    'analytics.dashboard.viewed': {
      title: 'Access Analytics Dashboard Viewed',
      body: `${safe(ctx.actor)} opened the access-analytics dashboard.`,
      severity: 'info',
    },
    'analytics.blindspot.viewed': {
      title: 'Access Analytics Blindspot Drilldown',
      body: `${safe(ctx.actor)} opened a blindspot detail view.`,
      severity: 'info',
    },

    // ── Client onboarding kit (issue #62) ─────────────────────────
    // Payloads carry agencyId, clientId, kitKey, stepName, counts —
    // never credentials, never full directory rows.
    'client.onboarding_kit.applied': {
      title: 'Onboarding Kit Applied',
      body: `Kit "${safe(ctx.kitName || ctx.kitKey)}" started for ${safe(ctx.client)}; ${ctx.teamMemberCount ?? 0} team member(s) queued.`,
      severity: 'info',
    },
    'client.onboarding_kit.step.ok': {
      title: 'Onboarding Step Complete',
      body: `Step "${safe(ctx.stepName)}" completed for ${safe(ctx.client)} (kit: ${safe(ctx.kitKey)}).`,
      severity: 'info',
    },
    'client.onboarding_kit.step.failed': {
      title: 'Onboarding Step Failed',
      body: `Step "${safe(ctx.stepName)}" failed for ${safe(ctx.client)} (kit: ${safe(ctx.kitKey)}): ${safe(ctx.error)}.`,
      severity: 'warning',
    },
    'client.onboarded': {
      title: 'Client Onboarded',
      body: `${safe(ctx.client)} onboarded via kit "${safe(ctx.kitKey)}": ${ctx.provisionedCount ?? 0} provisioned, ${ctx.failedCount ?? 0} failed, ${ctx.welcomeCount ?? 0} welcome email(s) sent.`,
      severity: 'info',
    },

    // ── Partner Hub access (issue #63) ────────────────────────────
    'partner.created': {
      title: 'Partner Onboarded',
      body: `Partner org "${safe(ctx.partnerName)}" was created (${safe(ctx.partnerId)}).`,
      severity: 'info',
    },
    'partner.client_link.created': {
      title: 'Partner Linked to Client',
      body: `Partner ${safe(ctx.partnerId)} granted ${safe(ctx.roleBundle)} on client ${safe(ctx.clientId)}.`,
      severity: 'info',
    },
    'partner.client_link.removed': {
      title: 'Partner Unlinked from Client',
      body: `Partner ${safe(ctx.partnerId)} no longer has access to client ${safe(ctx.clientId)}.`,
      severity: 'info',
    },
    'partner.user.linked': {
      title: 'Partner User Linked',
      body: `Directory user ${safe(ctx.partnerUserId)} was associated with partner ${safe(ctx.partnerId)}.`,
      severity: 'info',
    },
    'partner.archived': {
      title: 'Partner Archived',
      body: `Partner "${safe(ctx.partnerName)}" (${safe(ctx.partnerId)}) archived; client links revoked.`,
      severity: 'warning',
    },
    'partner.access_review.digest_sent': {
      title: 'Monthly Partner Access Review',
      body: `Agency ${safe(ctx.agencyId)} — ${ctx.activePartners ?? 0} active partner(s), ${ctx.linkedClients ?? 0} client link(s). Review now.`,
      severity: 'info',
    },
  };

  const template = MESSAGES[eventType];
  if (!template) {
    return {
      title: eventType,
      body: JSON.stringify(context),
      severity: 'info',
    };
  }

  return { ...template };
}

/**
 * Event subscription categories for the settings UI.
 */
export const EVENT_SUBSCRIPTION_CATEGORIES: EventSubscriptionCategory[] = [
  {
    key: 'access',
    label: 'Access Management',
    description: 'Access requests, approvals, provisioning, and verification',
    events: [
      { pattern: 'access.request.*', label: 'Access requests (created, approved, denied, completed)' },
      { pattern: 'access.verification.*', label: 'Access verification (validated, failed)' },
      { pattern: 'access.expiration.*', label: 'Access expiration (expiring, expired, extension)' },
      { pattern: 'campaign.*', label: 'Campaign lifecycle (created, ended, member added/removed/revoked)' },
    ],
  },
  {
    key: 'security',
    label: 'Security',
    description: 'PAM sessions, drift detection, break-glass, SoD violations',
    events: [
      { pattern: 'pam.*', label: 'PAM sessions (checkout, check-in, force terminate)' },
      { pattern: 'drift.*', label: 'Drift detection (detected, resolved)' },
      { pattern: 'breakglass.*', label: 'Break-glass access (credential revealed, rotated)' },
      { pattern: 'sod.*', label: 'SoD violations' },
    ],
  },
  {
    key: 'identity',
    label: 'Identity Lifecycle',
    description: 'JML events, provisioning, directory sync',
    events: [
      { pattern: 'jml.*', label: 'JML events (joiner, mover, leaver)' },
      { pattern: 'identity.provisioning.*', label: 'Identity provisioning (created, failed)' },
      { pattern: 'provisioning.template.apply.*', label: 'Role template apply (started, per-platform, completed)' },
      { pattern: 'directory.sync.*', label: 'Directory sync (completed, errors)' },
      { pattern: 'directory.user.contract_*', label: 'Contractor lifecycle (updated, renewed, expiring, expired)' },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    description: 'Client creation, onboarding kit application, per-step progress',
    events: [
      { pattern: 'client.onboarding_kit.*', label: 'Client onboarding kit (applied, step ok, step failed)' },
      { pattern: 'client.onboarded', label: 'Client onboarded' },
    ],
  },
  {
    key: 'partners',
    label: 'Partners',
    description: 'Partner onboarding, client scope changes, monthly access review',
    events: [
      { pattern: 'partner.*', label: 'Partner lifecycle (created, linked, archived, review)' },
    ],
  },
  {
    key: 'system',
    label: 'System',
    description: 'SIEM forwarding, billing, critical audit events',
    events: [
      { pattern: 'siem.*', label: 'SIEM forwarding errors' },
      { pattern: 'billing.*', label: 'Billing (upgrade, payment failed)' },
    ],
  },
  {
    key: 'reports',
    label: 'Client Trust Reports',
    description: 'Quarterly client-facing trust report generation and delivery',
    events: [
      { pattern: 'client.trust_report.*', label: 'Trust reports (generated, delivered, failed, subscribed)' },
    ],
  },
];

export { SEVERITY_MAP };
