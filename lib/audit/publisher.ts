/**
 * Audit Event Publisher
 *
 * Publishes events to Elasticsearch with:
 * - Hash chain computation (best-effort, per-agency)
 * - Async/non-blocking — never slows down business operations
 * - Batch buffering for throughput (flushes every 2s or at 50 events)
 * - Pluggable notification hook (set via setNotificationHook)
 */

import crypto from 'crypto';
import { bulkIndex, indexDocument, ping, ensureCurrentIndex } from './client.js';
import { getLatestEventHashForAgency } from './verify.js';
import { getRuntime } from '../runtime.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface AuditEventPayload {
  type?: string;
  eventType?: string;
  action?: string;
  source?: string;
  severity?: string;
  actor?: { id: string | null; email?: string | null; name?: string | null; type?: string; ip?: string | null; [key: string]: unknown };
  target?: { id: string | null; type: string; name?: string | null };
  resource?: { type?: string; id?: string | null; name?: string | null };
  agency?: { id: string | null; slug?: string | null };
  client?: { id: string | null; name?: string | null };
  context?: Record<string, unknown>;
  agency_id?: string | null;
  timestamp?: Date | string;
  retentionDays?: number;
  [key: string]: unknown;
}

export interface NotificationEvent {
  type: string;
  action: string;
  [key: string]: unknown;
}

interface InternalAuditEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  source: string;
  severity: string;
  actor: { id: string | null; email: string | null; type: string; ip: string | null };
  agency: { id: string | null; slug: string | null };
  client?: { id: string | null; name: string | null };
  resource?: { type: string | null; id: string | null; name: string | null };
  context: Record<string, unknown>;
  retentionDays: number;
  eventHash: string;
  prevHash: string;
}

// ─── Hash Chain ──────────────────────────────────────────────────────────────
//
// Cross-process correctness: each chained (agency-scoped) publish takes a
// Postgres advisory lock keyed on the agency id, reads the latest event
// hash from ES inside the lock, computes its own hash, writes the event
// to ES with `?refresh=wait_for` so subsequent readers see it, and
// releases the lock. Buffer flushing is bypassed for chained events —
// the lock-then-write pattern only works if our write is durable in ES
// before the next process can read.
//
// System-level events (no agency id) participate in no chain and stay on
// the original buffer-and-flush path for throughput.
//
// The pre-fix design used an in-process Map (`_lastHashByAgency`) plus a
// per-agency Promise queue. Single-process correct, multi-process broken:
// each process hydrated from ES once, then forked its own chain. Trevox
// chain integrity was demonstrably broken (multiple prev_hash_mismatch
// per hour) before this fix landed.

const GENESIS_PREV_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

// Stable 64-bit lock key derivation. Postgres pg_advisory_lock takes a bigint;
// we hash agency_id into a deterministic int64. MIT-style sha256-then-hi-lo.
function lockKeyForAgency(agencyId: string): bigint {
  const h = crypto.createHash('sha256').update(`audit-chain:${agencyId}`).digest();
  // Use the first 8 bytes as a signed bigint, masked into PG's bigint range.
  const hi = h.readUInt32BE(0);
  const lo = h.readUInt32BE(4);
  // Combine with bit-arithmetic; mask to 63 bits to stay positive.
  return ((BigInt(hi) << 32n) | BigInt(lo)) & ((1n << 63n) - 1n);
}

function computeEventHash(event: InternalAuditEvent): string {
  const payload = JSON.stringify({
    eventId: event.eventId,
    timestamp: event.timestamp,
    eventType: event.eventType,
    source: event.source,
    actor: event.actor,
    agency: event.agency,
    resource: event.resource,
    context: event.context,
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Acquire a Postgres advisory lock for `agencyId` and run `fn` inside it,
 * passing the latest event hash from ES (read inside the lock). The lock
 * is released when the surrounding $transaction commits or rolls back.
 *
 * Uses pg_advisory_xact_lock so the lock auto-releases at transaction end —
 * no leaked locks even if `fn` throws.
 *
 * The transaction is short and only holds the lock; the actual ES write
 * inside `fn` is what matters for chain durability. We use refresh=wait_for
 * on the ES write so the next process to acquire the lock and read the
 * latest hash sees our event.
 */
async function withCrossProcessAgencyLock<T>(
  agencyId: string,
  fn: (prevHash: string) => Promise<T>,
): Promise<T> {
  const { prisma } = getRuntime();
  if (!prisma) {
    // Runtime not initialized (e.g. CLI tooling that imports this module
    // without setRuntime). Fall back to GENESIS on best-effort. This is
    // worse than holding the lock but better than throwing — historically
    // the publisher was best-effort anyway.
    console.warn('[Audit] Runtime prisma missing — chain lock skipped for ' + agencyId);
    return fn(GENESIS_PREV_HASH);
  }
  const lockKey = lockKeyForAgency(agencyId);
  return prisma.$transaction(async (tx: { $executeRawUnsafe: (q: string) => Promise<unknown> }) => {
    // pg_advisory_xact_lock auto-releases at transaction end. Two-arg
    // form takes (int4, int4); single-arg takes int8 — we use single-arg.
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${lockKey.toString()}::bigint)`);
    let prevHash = GENESIS_PREV_HASH;
    try {
      const latest = await getLatestEventHashForAgency(agencyId);
      if (latest) prevHash = latest;
    } catch (err: unknown) {
      console.error('[Audit] Failed to read latest hash from ES inside lock:', (err as Error).message);
      // Continue with GENESIS — better to have a chain break here than
      // to lose the audit event entirely.
    }
    return fn(prevHash);
  });
}

// Exported for backward-compat with tests; the in-process maps are gone
// post-multi-process-fork-fix, so this is a no-op. Kept so call sites in
// existing test files don't need to change.
export function __resetHashChainStateForTest(): void {
  /* no-op: state lives in Postgres advisory locks + ES, not in-process */
}

// ─── Buffer ──────────────────────────────────────────────────────────────────

const BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;

let _buffer: InternalAuditEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _esAvailable = true;
let _initialized = false;

async function checkES(): Promise<boolean> {
  _esAvailable = await ping();
  return _esAvailable;
}

function startFlushTimer(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    if (_buffer.length > 0) flush().catch(err => console.error('[Audit] Flush error:', (err as Error).message));
  }, FLUSH_INTERVAL_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

async function flush(): Promise<void> {
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0);

  if (!_esAvailable) {
    await checkES();
  }

  if (_esAvailable) {
    try {
      const result = await bulkIndex(batch as unknown as import('./client.js').AuditDocument[]);
      if (result.errors) {
        const failed = result.items?.filter((i: Record<string, unknown>) => {
          const idx = i.index as Record<string, unknown> | undefined;
          return idx?.error;
        }) || [];
        console.error(`[Audit] Bulk index had ${failed.length} errors`);
      }
    } catch (err: unknown) {
      console.error('[Audit] Bulk index failed:', (err as Error).message);
      _esAvailable = false;
      for (const event of batch) {
        console.error('[Audit] Lost event (ES down):', JSON.stringify({ eventId: event.eventId, eventType: event.eventType, agencyId: event.agency?.id }));
      }
    }
  } else {
    console.warn(`[Audit] ES unavailable, dropping ${batch.length} events`);
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function init(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  if (!process.env.SEARCHBOX_URL) {
    console.warn('[Audit] SEARCHBOX_URL not set — audit events will be dropped');
    _esAvailable = false;
    return;
  }

  try {
    _esAvailable = await ping();
    if (_esAvailable) {
      await ensureCurrentIndex();
    }
  } catch (err: unknown) {
    console.warn('[Audit] ES init failed — events will be dropped until ES recovers:', (err as Error).message);
    _esAvailable = false;
  }

  startFlushTimer();
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function publishAuditEvent(params: AuditEventPayload): Promise<InternalAuditEvent> {
  if (!_initialized) await init();

  const event: InternalAuditEvent = {
    eventId: crypto.randomUUID(),
    // Timestamp deliberately stamped LATER for chained events. The verify
    // path orders the chain by `timestamp` ascending — so the timestamp
    // order MUST match the lock acquisition order, otherwise two concurrent
    // publishers can leave the chain in a state that decodes as broken.
    // For system-level (un-chained) events the buffer path stamps below.
    timestamp: '',
    eventType: params.eventType || params.type || 'unknown',
    source: params.source || 'accesshive',
    severity: params.severity || 'info',
    actor: {
      id: params.actor?.id || null,
      email: params.actor?.email || null,
      type: params.actor?.type || 'user',
      ip: params.actor?.ip || null,
    },
    agency: {
      id: params.agency?.id || params.agency_id || null,
      slug: params.agency?.slug || null,
    },
    client: params.client ? {
      id: params.client.id || null,
      name: params.client.name || null,
    } : undefined,
    resource: params.resource ? {
      type: params.resource.type || null,
      id: params.resource.id || null,
      name: params.resource.name || null,
    } : undefined,
    context: params.context || {},
    retentionDays: params.retentionDays || 90,
    eventHash: '',
    prevHash: '',
  };

  // Compute hash chain.
  //
  // Chained events (agency-scoped) take a Postgres advisory lock keyed on
  // the agency, read the latest hash from ES inside the lock, compute the
  // new hash, and write directly to ES with refresh=wait_for so the next
  // lock-holder reads our event. Buffer is bypassed for chained events —
  // the lock-then-write pattern requires durable ES persistence before
  // the lock releases.
  //
  // System-level events (no agency_id) keep the buffer-and-flush path for
  // throughput; they participate in no chain.
  const agencyId = event.agency.id;
  if (agencyId) {
    await withCrossProcessAgencyLock(agencyId, async (prevHash) => {
      // Stamp `timestamp` INSIDE the lock so the chain's authored time
      // matches its lock-acquisition order. Without this, a concurrent
      // caller that entered `publishAuditEvent` first but lost the lock
      // race ends up with an EARLIER timestamp than its predecessor —
      // the verifier (which sorts ascending by timestamp) then sees its
      // prev_hash pointing at the wrong neighbour and reports a break.
      event.timestamp = new Date().toISOString();
      event.prevHash = prevHash;
      event.eventHash = computeEventHash(event);
      // Direct write with refresh=wait_for so the next lock-holder sees
      // this event when it reads the latest hash from ES.
      await indexDocument(
        event as unknown as import('./client.js').AuditDocument,
        { refresh: 'wait_for' },
      );
    });

    // Fire-and-forget notification dispatch (unchanged from original flow).
    maybeNotify(event).catch(() => {});
    return event;
  }

  // System-level (unchained) event — keep the original buffer pattern.
  // Un-chained events don't need lock-ordered timestamps; stamp now.
  event.timestamp = new Date().toISOString();
  event.prevHash = GENESIS_PREV_HASH;
  event.eventHash = computeEventHash(event);

  // Add to buffer
  _buffer.push(event);

  // Flush immediately if buffer is full
  if (_buffer.length >= BUFFER_SIZE) {
    flush().catch(err => console.error('[Audit] Immediate flush error:', (err as Error).message));
  }

  // Fire-and-forget: dispatch notifications for actionable events
  maybeNotify(event).catch(() => {});

  return event;
}

// ─── Notification Dispatch Hook ──────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _notificationHook: ((...args: any[]) => any) | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setNotificationHook(hookFn: (...args: any[]) => any): void {
  _notificationHook = hookFn;
}

const NOTIFIABLE_PREFIXES = [
  'access.request',
  'access.verification',
  'access.expiration',
  'pam.session',
  'drift',
  'breakglass',
  'sod',
  'jml',
  'identity.provisioning',
  'directory.sync',
  'siem',
  'billing',
];

function shouldNotify(event: InternalAuditEvent): boolean {
  return NOTIFIABLE_PREFIXES.some(prefix => event.eventType.startsWith(prefix));
}

async function maybeNotify(event: InternalAuditEvent): Promise<void> {
  if (!_notificationHook || !shouldNotify(event)) return;
  try {
    await _notificationHook(event.agency?.id, event.eventType, {
      ...event.context,
      actor: event.actor?.email,
    });
  } catch (err: unknown) {
    console.error('[Audit] Notification dispatch error (non-fatal):', (err as Error).message);
  }
}

// ─── Legacy Event Support ────────────────────────────────────────────────────

interface LegacyEventParams {
  event: string;
  actor?: string;
  agencyId?: string;
  agencySlug?: string;
  requestId?: string;
  itemId?: string;
  platformId?: string;
  details?: Record<string, unknown>;
}

export async function publishLegacyEvent(params: LegacyEventParams | Record<string, unknown>): Promise<void> {
  const p = params as LegacyEventParams;
  const eventType = mapLegacyEventType(p.event || '');

  const resource: { type?: string; id?: string; name?: string } = {};
  if (p.requestId) { resource.type = 'access-request'; resource.id = p.requestId; }
  else if (p.itemId) { resource.type = 'access-item'; resource.id = p.itemId; }
  else if (p.platformId) { resource.type = 'platform'; resource.id = p.platformId; }
  else if (p.details?.identityId) { resource.type = 'identity'; resource.id = p.details.identityId as string; }
  else if (p.details?.clientId) { resource.type = 'client'; resource.id = p.details.clientId as string; }
  else if (p.details?.userId) { resource.type = 'user'; resource.id = p.details.userId as string; }

  if (p.details?.name) resource.name = p.details.name as string;

  const client = p.details?.clientId
    ? { id: p.details.clientId as string, name: (p.details.clientName as string) || null }
    : undefined;

  await publishAuditEvent({
    eventType,
    source: 'accesshive',
    actor: { id: p.actor || null, email: p.actor || null, type: 'user' },
    agency: { id: p.agencyId || null, slug: p.agencySlug || null },
    client,
    resource: resource.type ? resource as AuditEventPayload['resource'] : undefined,
    context: { ...p.details, _legacyEvent: p.event },
  });
}

export async function flushAll(): Promise<void> {
  await flush();
}

// ─── Legacy Event Type Mapping ───────────────────────────────────────────────

function mapLegacyEventType(legacyEvent: string): string {
  const MAP: Record<string, string> = {
    'ACCESS_REQUEST_CREATED': 'access.request.created',
    'ACCESS_REQUEST_APPROVED': 'access.request.approved',
    'ACCESS_REQUEST_COMPLETED': 'access.request.completed',
    'ACCESS_REQUEST_CANCELLED': 'access.request.cancelled',
    'ACCESS_REQUEST_REJECTED': 'access.request.rejected',
    'ACCESS_ITEM_CREATED': 'access.item.created',
    'ACCESS_ITEM_UPDATED': 'access.item.updated',
    'ACCESS_ITEM_DELETED': 'access.item.deleted',
    'ACCESS_ITEM_VALIDATED': 'access.item.validated',
    'IDENTITY_CREATED': 'identity.created',
    'IDENTITY_UPDATED': 'identity.updated',
    'IDENTITY_DELETED': 'identity.deleted',
    'IDENTITY_TOGGLED': 'identity.toggled',
    'IDENTITY_SOURCE_DELETED': 'identity.source.deleted',
    'IDENTITY_PROVISIONED': 'identity.dedicated.provisioned',
    'PAM_SESSION_START': 'pam.session.checkout',
    'PAM_SESSION_END': 'pam.session.checkin',
    'PAM_SESSION_EXPIRED': 'pam.session.expired',
    'PAM_SESSION_EXTENDED': 'pam.session.extended',
    'PAM_SESSION_TERMINATED': 'pam.session.force_terminated',
    'PAM_APPROVAL_REQUESTED': 'pam.approval.requested',
    'PAM_APPROVAL_APPROVED': 'pam.approval.approved',
    'PAM_APPROVAL_DENIED': 'pam.approval.denied',
    'CLIENT_CREATED': 'admin.client.created',
    'CLIENT_UPDATED': 'admin.client.updated',
    'CLIENT_DELETED': 'admin.client.deleted',
    'CLIENT_CONTACT_ADDED': 'admin.client.contact.added',
    'CLIENT_CONTACT_UPDATED': 'admin.client.contact.updated',
    'CLIENT_CONTACT_DELETED': 'admin.client.contact.deleted',
    'PLATFORM_ADDED': 'admin.platform.added',
    'PLATFORM_REMOVED': 'admin.platform.removed',
    'PLATFORM_TOGGLED': 'admin.platform.toggled',
    'PLATFORM_CONFIG_UPDATED': 'admin.platform.configured',
    'USER_INVITED': 'admin.user.invited',
    'USER_UPDATED': 'admin.user.updated',
    'USER_ROLE_ASSIGNED': 'admin.role.assigned',
    'USER_DEACTIVATED': 'admin.user.deactivated',
    'SETTINGS_UPDATED': 'admin.settings.updated',
    'CREDENTIAL_SAVED': 'credential.saved',
    'CREDENTIAL_ROTATED': 'credential.rotated',
    'CREDENTIAL_REVEALED': 'credential.revealed',
    'BREAKGLASS_REVEAL': 'credential.breakglass.revealed',
    'BREAKGLASS_ROTATION': 'credential.breakglass.rotated',
    'TOTP_SEED_CONFIGURED': 'identity.totp.seed.configured',
    'TOTP_SEED_ROTATED': 'identity.totp.seed.rotated',
    'TOTP_CODE_REVEALED': 'identity.totp.code.revealed',
    'TOTP_CODE_DENIED': 'identity.totp.code.denied',
    'TOTP_BACKUP_CODE_USED': 'identity.totp.backup_code.used',
    'NOTIFICATION_CHANNEL_CREATED': 'admin.notification.created',
    'NOTIFICATION_CHANNEL_UPDATED': 'admin.notification.updated',
    'NOTIFICATION_CHANNEL_DELETED': 'admin.notification.deleted',
    'PLUGIN_GOVERNANCE_UPDATED': 'admin.plugin.governance_updated',
    'CLIENT_GROUP_BINDING_CREATED': 'admin.client.group_binding.created',
    'CLIENT_GROUP_BINDING_DELETED': 'admin.client.group_binding.deleted',
    'CLIENT_OWNER_ASSIGNED': 'admin.client.owner.assigned',
    'CLIENT_OWNER_REMOVED': 'admin.client.owner.removed',
    'VERIFICATION_IDENTITY_CONNECTED': 'admin.client.verification.connected',
    'IDENTITY_SOURCE_CONFIGURED': 'identity.source.configured',
    'IDENTITY_SOURCE_DISCONNECTED': 'identity.source.disconnected',
    'GWS_USERS_SUSPENDED': 'platform.gws.users.suspended',
    'GWS_USERS_UNSUSPENDED': 'platform.gws.users.unsuspended',
    'GWS_USERS_MOVED_TO_OU': 'platform.gws.users.moved_to_ou',
    'GWS_OU_CREATED': 'platform.gws.ou.created',
    'KEYCLOAK_CONFIG_FIXED': 'keycloak.admin.config.fixed',
    'ACCESS_VERIFIED': 'access.item.verified',
    'ACCESS_EXPIRATION_SET': 'access.item.expiration_set',
    'ACCESS_ITEM_EXPIRED': 'access.item.expired',
    'ACCESS_EXTENSION_REQUESTED': 'access.item.extension_requested',
    'ACCESS_EXTENSION_APPROVED': 'access.item.extension_approved',
    'ACCESS_EXTENSION_DENIED': 'access.item.extension_denied',
    'DISCOVERY_COMPLETED': 'system.discovery.completed',
    'AUDIT_POLL_TRIGGERED': 'system.audit_poll.triggered',
    'RETENTION_CLEANUP': 'system.retention.cleanup',
    'IDENTITY_PLATFORM_CONNECTED': 'identity.platform.connected',
    'IDENTITY_BULK_PROVISIONED': 'identity.bulk.provisioned',
    'DEDICATED_IDENTITY_CREATED': 'identity.dedicated.created',
    'DEDICATED_IDENTITY_UPDATED': 'identity.dedicated.updated',
    'CLIENT_CREDENTIAL_CREATED': 'credential.client.created',
    'CLIENT_CREDENTIAL_UPDATED': 'credential.client.updated',
    'PLATFORM_CREDENTIALS_SAVED': 'admin.platform.credentials_saved',
    'OAUTH_TOKEN_STORED': 'oauth.token.stored',
    'OAUTH_TARGET_SELECTED': 'oauth.target.selected',
    'OAUTH_TOKEN_UPDATED': 'oauth.token.updated',
    'ACCESS_GRANTED': 'access.granted',
    'ACCESS_REVOKED': 'access.revoked',
    'IDENTITY_SOURCE_CREATED': 'identity.source.created',
    'IDENTITY_SOURCE_SYNCED': 'identity.source.synced',
    'IDENTITY_SOURCE_UPDATED': 'identity.source.updated',
    'ROLE_MAPPING_CREATED': 'identity.role_mapping.created',
    'ROLE_MAPPING_UPDATED': 'identity.role_mapping.updated',
    'ROLE_MAPPING_DELETED': 'identity.role_mapping.deleted',
    'DERIVED_ROLES_RECOMPUTED': 'identity.derived_roles.recomputed',
    'IDENTITY_WRITE_ACTION': 'identity.write_action.executed',
    'PAM_CHECKOUT_INITIATED': 'pam.checkout.initiated',
    'PAM_CHECKOUT_COMPLETED': 'pam.checkout.completed',
    'PAM_CHECKOUT_CONFIRMED': 'pam.checkout.confirmed',
    'PAM_APPROVAL_RESOLVED': 'pam.approval.resolved',
    'PAM_SESSION_REVOKED': 'pam.session.revoked',
    'USER_LOGIN': 'auth.login.success',
    'USER_LOGIN_FAILED': 'auth.login.failed',
    'AGENCY_SIGNUP': 'auth.agency.signup',
    'AGENCY_CREATED': 'admin.agency.created',
    'AGENCY_SWITCHED': 'auth.agency.switched',
    'KEYCLOAK_REALM_PROVISIONED': 'keycloak.realm.provisioned',
    'IDENTITY_PROVISIONING_RETRIED': 'identity.provisioning.retried',
    'GWS_PROVISIONING_RETRIED': 'platform.gws.provisioning.retried',
    'GOOGLE_ADS_CAMPAIGN_CREATED': 'platform.google-ads.campaign.created',
    'GOOGLE_ADS_CAMPAIGN_UPDATED': 'platform.google-ads.campaign.updated',
    'GOOGLE_ADS_CAMPAIGN_DELETED': 'platform.google-ads.campaign.deleted',
    'GOOGLE_ADS_BUDGET_CHANGED': 'platform.google-ads.budget.changed',
    'GOOGLE_ADS_USER_ADDED': 'platform.google-ads.user.added',
    'GOOGLE_ADS_USER_REMOVED': 'platform.google-ads.user.removed',
    'GTM_VERSION_CREATED': 'platform.gtm.container.version_created',
    'GTM_TAG_CREATED': 'platform.gtm.tag.created',
    'GTM_TAG_UPDATED': 'platform.gtm.tag.updated',
    'GTM_TAG_DELETED': 'platform.gtm.tag.deleted',
    'META_AD_CREATED': 'platform.meta.ad.created',
    'META_AD_UPDATED': 'platform.meta.ad.updated',
    'META_AD_DELETED': 'platform.meta.ad.deleted',
    'META_CAMPAIGN_CREATED': 'platform.meta.campaign.created',
    'META_CAMPAIGN_UPDATED': 'platform.meta.campaign.updated',
    'META_CAMPAIGN_DELETED': 'platform.meta.campaign.deleted',
    'META_CAMPAIGN_BUDGET_CHANGED': 'platform.meta.campaign.budget_changed',
    'META_USER_ADDED': 'platform.meta.user.added',
    'META_USER_REMOVED': 'platform.meta.user.removed',
    'HUBSPOT_USER_LOGIN': 'platform.hubspot.user.login',
    'HUBSPOT_USER_LOGIN_FAILED': 'platform.hubspot.user.login_failed',
    'HUBSPOT_CONTACT_CREATED': 'platform.hubspot.contact.created',
    'HUBSPOT_CONTACT_UPDATED': 'platform.hubspot.contact.updated',
    'HUBSPOT_SETTING_CHANGED': 'platform.hubspot.setting.changed',
    'HUBSPOT_USER_ADDED': 'platform.hubspot.user.added',
    'HUBSPOT_USER_REMOVED': 'platform.hubspot.user.removed',
    'SALESFORCE_USER_LOGIN': 'platform.salesforce.user.login',
    'SALESFORCE_USER_LOGIN_FAILED': 'platform.salesforce.user.login_failed',
    'SALESFORCE_SETUP_CHANGED': 'platform.salesforce.setup.changed',
    'SALESFORCE_USER_CREATED': 'platform.salesforce.user.created',
    'SALESFORCE_USER_DEACTIVATED': 'platform.salesforce.user.deactivated',
    'SALESFORCE_PERMISSION_CHANGED': 'platform.salesforce.permission.changed',
    'SALESFORCE_PROFILE_CHANGED': 'platform.salesforce.profile.changed',
    'OKTA_USER_LOGIN': 'platform.okta.user.login',
    'OKTA_USER_LOGIN_FAILED': 'platform.okta.user.login_failed',
    'OKTA_USER_CREATED': 'platform.okta.user.created',
    'OKTA_USER_DEACTIVATED': 'platform.okta.user.deactivated',
    'OKTA_USER_SUSPENDED': 'platform.okta.user.suspended',
    'OKTA_USER_PASSWORD_CHANGED': 'platform.okta.user.password_changed',
    'OKTA_GROUP_MEMBER_ADDED': 'platform.okta.group.member_added',
    'OKTA_GROUP_MEMBER_REMOVED': 'platform.okta.group.member_removed',
    'OKTA_APP_ASSIGNED': 'platform.okta.app.assigned',
    'OKTA_APP_UNASSIGNED': 'platform.okta.app.unassigned',
    'OKTA_POLICY_CHANGED': 'platform.okta.policy.changed',
    'JUMPCLOUD_USER_LOGIN': 'platform.jumpcloud.user.login',
    'JUMPCLOUD_USER_LOGIN_FAILED': 'platform.jumpcloud.user.login_failed',
    'JUMPCLOUD_USER_CREATED': 'platform.jumpcloud.user.created',
    'JUMPCLOUD_USER_DELETED': 'platform.jumpcloud.user.deleted',
    'JUMPCLOUD_USER_UPDATED': 'platform.jumpcloud.user.updated',
    'JUMPCLOUD_USER_LOCKED': 'platform.jumpcloud.user.locked',
    'JUMPCLOUD_USER_PASSWORD_CHANGED': 'platform.jumpcloud.user.password_changed',
    'JUMPCLOUD_GROUP_MEMBER_ADDED': 'platform.jumpcloud.group.member_added',
    'JUMPCLOUD_GROUP_MEMBER_REMOVED': 'platform.jumpcloud.group.member_removed',
    'JUMPCLOUD_ADMIN_LOGIN': 'platform.jumpcloud.admin.login',
    'ONELOGIN_USER_LOGIN': 'platform.onelogin.user.login',
    'ONELOGIN_USER_LOGIN_FAILED': 'platform.onelogin.user.login_failed',
    'ONELOGIN_USER_CREATED': 'platform.onelogin.user.created',
    'ONELOGIN_USER_DELETED': 'platform.onelogin.user.deleted',
    'ONELOGIN_USER_UPDATED': 'platform.onelogin.user.updated',
    'ONELOGIN_USER_LOCKED': 'platform.onelogin.user.locked',
    'ONELOGIN_USER_PASSWORD_CHANGED': 'platform.onelogin.user.password_changed',
    'ONELOGIN_APP_PROVISIONED': 'platform.onelogin.app.provisioned',
    'ONELOGIN_APP_DEPROVISIONED': 'platform.onelogin.app.deprovisioned',
    'ONELOGIN_ROLE_ASSIGNED': 'platform.onelogin.role.assigned',
    'ONELOGIN_ROLE_REMOVED': 'platform.onelogin.role.removed',
    'SCIM_USER_CREATED': 'scim.user.created',
    'SCIM_USER_UPDATED': 'scim.user.updated',
    'SCIM_USER_DELETED': 'scim.user.deleted',
    'SCIM_GROUP_CREATED': 'scim.group.created',
    'SCIM_GROUP_UPDATED': 'scim.group.updated',
    'SCIM_GROUP_DELETED': 'scim.group.deleted',
    'JML_JOINER_DETECTED': 'jml.joiner.detected',
    'JML_JOINER_PROVISIONED': 'jml.joiner.provisioned',
    'JML_JOINER_NOTIFIED': 'jml.joiner.notified',
    'RISK_ASSESSMENT_COMPUTED': 'governance.risk_assessment.computed',
    'RECOMMENDATION_REMEDIATED': 'governance.recommendation.remediated',
    'SOD_POLICY_CREATED': 'governance.sod_policy.created',
    'SOD_POLICY_DELETED': 'governance.sod_policy.deleted',
    'SOD_VIOLATION_DETECTED': 'governance.sod_violation.detected',
    'BILLING_UPGRADE_INITIATED': 'billing.upgrade.initiated',
    'BILLING_UPGRADE_COMPLETED': 'billing.upgrade.completed',
    'BILLING_DOWNGRADE_COMPLETED': 'billing.downgrade.completed',
    'BILLING_DOWNGRADE_BLOCKED': 'billing.downgrade.blocked',
    'BILLING_PAYMENT_SUCCEEDED': 'billing.payment.succeeded',
    'BILLING_PAYMENT_FAILED': 'billing.payment.failed',
    'BILLING_TRIAL_STARTED': 'billing.trial.started',
    'BILLING_TRIAL_ENDED': 'billing.trial.ended',
    'BILLING_TRIAL_CONVERTED': 'billing.trial.converted',
    'SIEM_CONFIG_UPDATED': 'siem.config.updated',
    'SIEM_TEST_SENT': 'siem.config.test_sent',
    'SIEM_FORWARDING_ERROR': 'siem.forwarding.error',
    'SIEM_FORWARDING_DISABLED': 'siem.forwarding.disabled',
    'BULK_IMPORT_SUBMITTED': 'admin.bulk_import.submitted',
    'BULK_IMPORT_COMPLETED': 'admin.bulk_import.completed',
    'BULK_IMPORT_FAILED': 'admin.bulk_import.failed',
    'REMEDIATION_EVALUATED': 'remediation.evaluated',
    'REMEDIATION_AUTO_EXECUTED': 'remediation.auto_executed',
    'REMEDIATION_WORKFLOW_CREATED': 'remediation.workflow_created',
    'REMEDIATION_MANUAL_RECOMMENDED': 'remediation.manual_recommended',
    'REMEDIATION_SCHEDULED': 'remediation.scheduled',
    'REMEDIATION_COMPLETED': 'remediation.completed',
    'REMEDIATION_FAILED': 'remediation.failed',
    'REMEDIATION_REVERTED': 'remediation.reverted',
    'REMEDIATION_CANCELLED': 'remediation.cancelled',
    'REMEDIATION_RATE_LIMITED': 'remediation.rate_limited',
    'REMEDIATION_DRY_RUN': 'remediation.dry_run',
  };

  return MAP[legacyEvent] || `legacy.${legacyEvent.toLowerCase().replace(/_/g, '.')}`;
}
