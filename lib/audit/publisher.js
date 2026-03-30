/**
 * Audit Event Publisher
 *
 * Replaces addAuditLog(). Publishes events to Elasticsearch with:
 * - Hash chain computation (best-effort, per-agency)
 * - Async/non-blocking — never slows down business operations
 * - Batch buffering for throughput (flushes every 2s or at 50 events)
 * - Pluggable notification hook (set via setNotificationHook)
 */

import crypto from 'crypto';
import { indexDocument, bulkIndex, ping, ensureCurrentIndex } from './client.js';

// ─── Hash Chain ──────────────────────────────────────────────────────────────

// In-memory cache of last hash per agency (best-effort)
const _lastHashByAgency = new Map();

function computeEventHash(event) {
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

function getPrevHash(agencyId) {
  return _lastHashByAgency.get(agencyId) || '0000000000000000000000000000000000000000000000000000000000000000';
}

// ─── Buffer ──────────────────────────────────────────────────────────────────

const BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;

let _buffer = [];
let _flushTimer = null;
let _esAvailable = true;
let _initialized = false;

async function checkES() {
  _esAvailable = await ping();
  return _esAvailable;
}

function startFlushTimer() {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    if (_buffer.length > 0) flush().catch(err => console.error('[Audit] Flush error:', err.message));
  }, FLUSH_INTERVAL_MS);
  // Don't block process exit
  if (_flushTimer.unref) _flushTimer.unref();
}

/**
 * Flush buffered events to Elasticsearch.
 */
async function flush() {
  if (_buffer.length === 0) return;

  const batch = _buffer.splice(0);

  if (!_esAvailable) {
    await checkES();
  }

  if (_esAvailable) {
    try {
      const result = await bulkIndex(batch);
      if (result.errors) {
        const failed = result.items?.filter(i => i.index?.error) || [];
        console.error(`[Audit] Bulk index had ${failed.length} errors`);
      }
    } catch (err) {
      console.error('[Audit] Bulk index failed:', err.message);
      _esAvailable = false;
      // Events are lost — log them so they appear in Heroku logs
      for (const event of batch) {
        console.error('[Audit] Lost event (ES down):', JSON.stringify({ eventId: event.eventId, eventType: event.eventType, agencyId: event.agency?.id }));
      }
    }
  } else {
    // ES unavailable — log and drop
    console.warn(`[Audit] ES unavailable, dropping ${batch.length} events`);
  }
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function init() {
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
  } catch (err) {
    console.warn('[Audit] ES init failed — events will be dropped until ES recovers:', err.message);
    _esAvailable = false;
  }

  // Auto-wire notification hook if available (web app has it, worker may not)
  if (!_notificationHook) {
    try {
      await import('./init.js');
    } catch {
      // init.js not available (shared/worker context) — no notification hook
    }
  }

  startFlushTimer();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Publish an audit event.
 *
 * @param {Object} params
 * @param {string} params.eventType      - Hierarchical event type (e.g. 'admin.client.created')
 * @param {string} params.source         - Event source ('accesshive', 'keycloak', etc.)
 * @param {string} [params.severity]     - 'info' | 'warning' | 'critical' (default: 'info')
 * @param {Object} params.actor          - { id, email, type, ip }
 * @param {Object} params.agency         - { id, slug }
 * @param {Object} [params.client]       - { id, name } (optional, for client-scoped events)
 * @param {Object} [params.resource]     - { type, id, name }
 * @param {Object} [params.context]      - Event-specific details
 * @param {number} [params.retentionDays] - From Lago entitlement
 */
export async function publishAuditEvent(params) {
  // Lazy init
  if (!_initialized) await init();

  const event = {
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    eventType: params.eventType,
    source: params.source || 'accesshive',
    severity: params.severity || 'info',
    actor: {
      id: params.actor?.id || null,
      email: params.actor?.email || null,
      type: params.actor?.type || 'user',
      ip: params.actor?.ip || null,
    },
    agency: {
      id: params.agency?.id || null,
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
  };

  // Compute hash chain
  const agencyId = event.agency.id;
  event.prevHash = getPrevHash(agencyId);
  event.eventHash = computeEventHash(event);
  if (agencyId) _lastHashByAgency.set(agencyId, event.eventHash);

  // Add to buffer
  _buffer.push(event);

  // Flush immediately if buffer is full
  if (_buffer.length >= BUFFER_SIZE) {
    flush().catch(err => console.error('[Audit] Immediate flush error:', err.message));
  }

  // Fire-and-forget: dispatch notifications for actionable events
  maybeNotify(event).catch(() => {});

  return event;
}

// ─── Notification Dispatch Hook ──────────────────────────────────────────────

let _notificationHook = null;

/**
 * Set a notification hook that fires for actionable audit events.
 * The hook receives (agencyId, eventType, context).
 * Used by the web app to wire in notification dispatch; the worker can set its own hook or leave null.
 */
export function setNotificationHook(hookFn) {
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

function shouldNotify(event) {
  return NOTIFIABLE_PREFIXES.some(prefix => event.eventType.startsWith(prefix));
}

async function maybeNotify(event) {
  if (!_notificationHook || !shouldNotify(event)) return;
  try {
    await _notificationHook(event.agency?.id, event.eventType, {
      ...event.context,
      actor: event.actor?.email || event.actor?.name,
    });
  } catch (err) {
    console.error('[Audit] Notification dispatch error (non-fatal):', err.message);
  }
}

/**
 * Convenience: publish from the legacy addAuditLog format.
 * Maps the old { event, actor, agencyId, details } shape to the new schema.
 */
export async function publishLegacyEvent({ event, actor, agencyId, agencySlug, requestId, itemId, platformId, details }) {
  // Map old event names to new taxonomy
  const eventType = mapLegacyEventType(event);

  // Determine resource from details or IDs
  const resource = {};
  if (requestId) { resource.type = 'access-request'; resource.id = requestId; }
  else if (itemId) { resource.type = 'access-item'; resource.id = itemId; }
  else if (platformId) { resource.type = 'platform'; resource.id = platformId; }
  else if (details?.identityId) { resource.type = 'identity'; resource.id = details.identityId; }
  else if (details?.clientId) { resource.type = 'client'; resource.id = details.clientId; }
  else if (details?.userId) { resource.type = 'user'; resource.id = details.userId; }

  if (details?.name) resource.name = details.name;

  // Extract client info from details if available
  const client = details?.clientId ? { id: details.clientId, name: details.clientName } : undefined;

  return publishAuditEvent({
    eventType,
    source: 'accesshive',
    actor: {
      id: actor,
      email: actor,
      type: 'user',
    },
    agency: { id: agencyId, slug: agencySlug },
    client,
    resource: resource.type ? resource : undefined,
    context: { ...details, _legacyEvent: event },
  });
}

/**
 * Force flush — call before process exit or in CLI scripts.
 */
export async function flushAll() {
  await flush();
}

// ─── Legacy Event Type Mapping ───────────────────────────────────────────────

function mapLegacyEventType(legacyEvent) {
  const MAP = {
    // Access
    'ACCESS_REQUEST_CREATED':     'access.request.created',
    'ACCESS_REQUEST_APPROVED':    'access.request.approved',
    'ACCESS_REQUEST_COMPLETED':   'access.request.completed',
    'ACCESS_REQUEST_CANCELLED':   'access.request.cancelled',
    'ACCESS_REQUEST_REJECTED':    'access.request.rejected',
    'ACCESS_ITEM_CREATED':        'access.item.created',
    'ACCESS_ITEM_UPDATED':        'access.item.updated',
    'ACCESS_ITEM_DELETED':        'access.item.deleted',
    'ACCESS_ITEM_VALIDATED':      'access.item.validated',

    // Identity
    'IDENTITY_CREATED':           'identity.created',
    'IDENTITY_UPDATED':           'identity.updated',
    'IDENTITY_DELETED':           'identity.deleted',
    'IDENTITY_TOGGLED':           'identity.toggled',
    'IDENTITY_SOURCE_DELETED':    'identity.source.deleted',
    'IDENTITY_PROVISIONED':       'identity.dedicated.provisioned',

    // PAM
    'PAM_SESSION_START':          'pam.session.checkout',
    'PAM_SESSION_END':            'pam.session.checkin',
    'PAM_SESSION_EXPIRED':        'pam.session.expired',
    'PAM_SESSION_EXTENDED':       'pam.session.extended',
    'PAM_SESSION_TERMINATED':     'pam.session.force_terminated',
    'PAM_APPROVAL_REQUESTED':     'pam.approval.requested',
    'PAM_APPROVAL_APPROVED':      'pam.approval.approved',
    'PAM_APPROVAL_DENIED':        'pam.approval.denied',

    // Admin
    'CLIENT_CREATED':             'admin.client.created',
    'CLIENT_UPDATED':             'admin.client.updated',
    'CLIENT_DELETED':             'admin.client.deleted',
    'CLIENT_CONTACT_ADDED':       'admin.client.contact.added',
    'CLIENT_CONTACT_UPDATED':     'admin.client.contact.updated',
    'CLIENT_CONTACT_DELETED':     'admin.client.contact.deleted',
    'PLATFORM_ADDED':             'admin.platform.added',
    'PLATFORM_REMOVED':           'admin.platform.removed',
    'PLATFORM_TOGGLED':           'admin.platform.toggled',
    'PLATFORM_CONFIG_UPDATED':    'admin.platform.configured',
    'USER_INVITED':               'admin.user.invited',
    'USER_UPDATED':               'admin.user.updated',
    'USER_ROLE_ASSIGNED':         'admin.role.assigned',
    'USER_DEACTIVATED':           'admin.user.deactivated',
    'SETTINGS_UPDATED':           'admin.settings.updated',

    // Credential
    'CREDENTIAL_SAVED':           'credential.saved',
    'CREDENTIAL_ROTATED':         'credential.rotated',
    'CREDENTIAL_REVEALED':        'credential.revealed',
    'BREAKGLASS_REVEAL':          'credential.breakglass.revealed',
    'BREAKGLASS_ROTATION':        'credential.breakglass.rotated',

    // Notification
    'NOTIFICATION_CHANNEL_CREATED':   'admin.notification.created',
    'NOTIFICATION_CHANNEL_UPDATED':   'admin.notification.updated',
    'NOTIFICATION_CHANNEL_DELETED':   'admin.notification.deleted',

    // Plugin governance
    'PLUGIN_GOVERNANCE_UPDATED':      'admin.plugin.governance_updated',

    // Client governance
    'CLIENT_GROUP_BINDING_CREATED':   'admin.client.group_binding.created',
    'CLIENT_GROUP_BINDING_DELETED':   'admin.client.group_binding.deleted',
    'CLIENT_OWNER_ASSIGNED':          'admin.client.owner.assigned',
    'CLIENT_OWNER_REMOVED':           'admin.client.owner.removed',
    'VERIFICATION_IDENTITY_CONNECTED': 'admin.client.verification.connected',

    // Identity source
    'IDENTITY_SOURCE_CONFIGURED':     'identity.source.configured',
    'IDENTITY_SOURCE_DISCONNECTED':   'identity.source.disconnected',

    // Google Workspace
    'GWS_USERS_SUSPENDED':            'platform.gws.users.suspended',
    'GWS_USERS_UNSUSPENDED':          'platform.gws.users.unsuspended',
    'GWS_USERS_MOVED_TO_OU':          'platform.gws.users.moved_to_ou',
    'GWS_OU_CREATED':                 'platform.gws.ou.created',

    // Keycloak
    'KEYCLOAK_CONFIG_FIXED':          'keycloak.admin.config.fixed',

    // Verification
    'ACCESS_VERIFIED':            'access.item.verified',

    // Time-bound access
    'ACCESS_EXPIRATION_SET':          'access.item.expiration_set',
    'ACCESS_ITEM_EXPIRED':            'access.item.expired',
    'ACCESS_EXTENSION_REQUESTED':     'access.item.extension_requested',
    'ACCESS_EXTENSION_APPROVED':      'access.item.extension_approved',
    'ACCESS_EXTENSION_DENIED':        'access.item.extension_denied',

    // System
    'DISCOVERY_COMPLETED':        'system.discovery.completed',
    'AUDIT_POLL_TRIGGERED':       'system.audit_poll.triggered',
    'RETENTION_CLEANUP':          'system.retention.cleanup',

    // Identity platform connections
    'IDENTITY_PLATFORM_CONNECTED': 'identity.platform.connected',
    'IDENTITY_BULK_PROVISIONED':   'identity.bulk.provisioned',
    'DEDICATED_IDENTITY_CREATED':  'identity.dedicated.created',
    'DEDICATED_IDENTITY_UPDATED':  'identity.dedicated.updated',
    'CLIENT_CREDENTIAL_CREATED':   'credential.client.created',
    'CLIENT_CREDENTIAL_UPDATED':   'credential.client.updated',
    'PLATFORM_CREDENTIALS_SAVED':  'admin.platform.credentials_saved',
    'OAUTH_TOKEN_STORED':          'oauth.token.stored',
    'OAUTH_TARGET_SELECTED':       'oauth.target.selected',
    'OAUTH_TOKEN_UPDATED':         'oauth.token.updated',
    'ACCESS_GRANTED':              'access.granted',
    'ACCESS_REVOKED':              'access.revoked',
    'IDENTITY_SOURCE_CREATED':     'identity.source.created',
    'IDENTITY_SOURCE_SYNCED':      'identity.source.synced',
    'IDENTITY_SOURCE_UPDATED':     'identity.source.updated',
    'ROLE_MAPPING_CREATED':        'identity.role_mapping.created',
    'ROLE_MAPPING_UPDATED':        'identity.role_mapping.updated',
    'ROLE_MAPPING_DELETED':        'identity.role_mapping.deleted',
    'DERIVED_ROLES_RECOMPUTED':    'identity.derived_roles.recomputed',
    'IDENTITY_WRITE_ACTION':       'identity.write_action.executed',

    // PAM checkout flow
    'PAM_CHECKOUT_INITIATED':      'pam.checkout.initiated',
    'PAM_CHECKOUT_COMPLETED':      'pam.checkout.completed',
    'PAM_CHECKOUT_CONFIRMED':      'pam.checkout.confirmed',
    'PAM_APPROVAL_RESOLVED':       'pam.approval.resolved',
    'PAM_SESSION_REVOKED':         'pam.session.revoked',

    // Auth & agency
    'USER_LOGIN':                  'auth.login.success',
    'USER_LOGIN_FAILED':           'auth.login.failed',
    'AGENCY_SIGNUP':               'auth.agency.signup',
    'AGENCY_CREATED':              'admin.agency.created',
    'AGENCY_SWITCHED':             'auth.agency.switched',

    // Admin provisioning
    'KEYCLOAK_REALM_PROVISIONED':  'keycloak.realm.provisioned',
    'IDENTITY_PROVISIONING_RETRIED': 'identity.provisioning.retried',
    'GWS_PROVISIONING_RETRIED':    'platform.gws.provisioning.retried',

    // ─── Google Ads ─────────────────────────────────────────────────────
    'GOOGLE_ADS_CAMPAIGN_CREATED':   'platform.google-ads.campaign.created',
    'GOOGLE_ADS_CAMPAIGN_UPDATED':   'platform.google-ads.campaign.updated',
    'GOOGLE_ADS_CAMPAIGN_DELETED':   'platform.google-ads.campaign.deleted',
    'GOOGLE_ADS_BUDGET_CHANGED':     'platform.google-ads.budget.changed',
    'GOOGLE_ADS_USER_ADDED':         'platform.google-ads.user.added',
    'GOOGLE_ADS_USER_REMOVED':       'platform.google-ads.user.removed',

    // ─── Google Tag Manager ─────────────────────────────────────────────
    'GTM_VERSION_CREATED':           'platform.gtm.container.version_created',
    'GTM_TAG_CREATED':               'platform.gtm.tag.created',
    'GTM_TAG_UPDATED':               'platform.gtm.tag.updated',
    'GTM_TAG_DELETED':               'platform.gtm.tag.deleted',

    // ─── Meta / Facebook ────────────────────────────────────────────────
    'META_AD_CREATED':               'platform.meta.ad.created',
    'META_AD_UPDATED':               'platform.meta.ad.updated',
    'META_AD_DELETED':               'platform.meta.ad.deleted',
    'META_CAMPAIGN_CREATED':         'platform.meta.campaign.created',
    'META_CAMPAIGN_UPDATED':         'platform.meta.campaign.updated',
    'META_CAMPAIGN_DELETED':         'platform.meta.campaign.deleted',
    'META_CAMPAIGN_BUDGET_CHANGED':  'platform.meta.campaign.budget_changed',
    'META_USER_ADDED':               'platform.meta.user.added',
    'META_USER_REMOVED':             'platform.meta.user.removed',

    // ─── HubSpot ────────────────────────────────────────────────────────
    'HUBSPOT_USER_LOGIN':            'platform.hubspot.user.login',
    'HUBSPOT_USER_LOGIN_FAILED':     'platform.hubspot.user.login_failed',
    'HUBSPOT_CONTACT_CREATED':       'platform.hubspot.contact.created',
    'HUBSPOT_CONTACT_UPDATED':       'platform.hubspot.contact.updated',
    'HUBSPOT_SETTING_CHANGED':       'platform.hubspot.setting.changed',
    'HUBSPOT_USER_ADDED':            'platform.hubspot.user.added',
    'HUBSPOT_USER_REMOVED':          'platform.hubspot.user.removed',

    // ─── Salesforce ─────────────────────────────────────────────────────
    'SALESFORCE_USER_LOGIN':         'platform.salesforce.user.login',
    'SALESFORCE_USER_LOGIN_FAILED':  'platform.salesforce.user.login_failed',
    'SALESFORCE_SETUP_CHANGED':      'platform.salesforce.setup.changed',
    'SALESFORCE_USER_CREATED':       'platform.salesforce.user.created',
    'SALESFORCE_USER_DEACTIVATED':   'platform.salesforce.user.deactivated',
    'SALESFORCE_PERMISSION_CHANGED': 'platform.salesforce.permission.changed',
    'SALESFORCE_PROFILE_CHANGED':    'platform.salesforce.profile.changed',

    // ─── Okta ───────────────────────────────────────────────────────────
    'OKTA_USER_LOGIN':               'platform.okta.user.login',
    'OKTA_USER_LOGIN_FAILED':        'platform.okta.user.login_failed',
    'OKTA_USER_CREATED':             'platform.okta.user.created',
    'OKTA_USER_DEACTIVATED':         'platform.okta.user.deactivated',
    'OKTA_USER_SUSPENDED':           'platform.okta.user.suspended',
    'OKTA_USER_PASSWORD_CHANGED':    'platform.okta.user.password_changed',
    'OKTA_GROUP_MEMBER_ADDED':       'platform.okta.group.member_added',
    'OKTA_GROUP_MEMBER_REMOVED':     'platform.okta.group.member_removed',
    'OKTA_APP_ASSIGNED':             'platform.okta.app.assigned',
    'OKTA_APP_UNASSIGNED':           'platform.okta.app.unassigned',
    'OKTA_POLICY_CHANGED':           'platform.okta.policy.changed',

    // ─── JumpCloud ──────────────────────────────────────────────────────
    'JUMPCLOUD_USER_LOGIN':          'platform.jumpcloud.user.login',
    'JUMPCLOUD_USER_LOGIN_FAILED':   'platform.jumpcloud.user.login_failed',
    'JUMPCLOUD_USER_CREATED':        'platform.jumpcloud.user.created',
    'JUMPCLOUD_USER_DELETED':        'platform.jumpcloud.user.deleted',
    'JUMPCLOUD_USER_UPDATED':        'platform.jumpcloud.user.updated',
    'JUMPCLOUD_USER_LOCKED':         'platform.jumpcloud.user.locked',
    'JUMPCLOUD_USER_PASSWORD_CHANGED': 'platform.jumpcloud.user.password_changed',
    'JUMPCLOUD_GROUP_MEMBER_ADDED':  'platform.jumpcloud.group.member_added',
    'JUMPCLOUD_GROUP_MEMBER_REMOVED': 'platform.jumpcloud.group.member_removed',
    'JUMPCLOUD_ADMIN_LOGIN':         'platform.jumpcloud.admin.login',

    // ─── OneLogin ───────────────────────────────────────────────────────
    'ONELOGIN_USER_LOGIN':           'platform.onelogin.user.login',
    'ONELOGIN_USER_LOGIN_FAILED':    'platform.onelogin.user.login_failed',
    'ONELOGIN_USER_CREATED':         'platform.onelogin.user.created',
    'ONELOGIN_USER_DELETED':         'platform.onelogin.user.deleted',
    'ONELOGIN_USER_UPDATED':         'platform.onelogin.user.updated',
    'ONELOGIN_USER_LOCKED':          'platform.onelogin.user.locked',
    'ONELOGIN_USER_PASSWORD_CHANGED': 'platform.onelogin.user.password_changed',
    'ONELOGIN_APP_PROVISIONED':      'platform.onelogin.app.provisioned',
    'ONELOGIN_APP_DEPROVISIONED':    'platform.onelogin.app.deprovisioned',
    'ONELOGIN_ROLE_ASSIGNED':        'platform.onelogin.role.assigned',
    'ONELOGIN_ROLE_REMOVED':         'platform.onelogin.role.removed',

    // ─── SCIM ────────────────────────────────────────────────────────────
    'SCIM_USER_CREATED':             'scim.user.created',
    'SCIM_USER_UPDATED':             'scim.user.updated',
    'SCIM_USER_DELETED':             'scim.user.deleted',
    'SCIM_GROUP_CREATED':            'scim.group.created',
    'SCIM_GROUP_UPDATED':            'scim.group.updated',
    'SCIM_GROUP_DELETED':            'scim.group.deleted',

    // ─── JML Joiner ─────────────────────────────────────────────────────
    'JML_JOINER_DETECTED':           'jml.joiner.detected',
    'JML_JOINER_PROVISIONED':        'jml.joiner.provisioned',
    'JML_JOINER_NOTIFIED':           'jml.joiner.notified',

    // ─── Governance / Permission Analysis ────────────────────────────────
    'RISK_ASSESSMENT_COMPUTED':       'governance.risk_assessment.computed',
    'RECOMMENDATION_REMEDIATED':      'governance.recommendation.remediated',
    'SOD_POLICY_CREATED':             'governance.sod_policy.created',
    'SOD_POLICY_DELETED':             'governance.sod_policy.deleted',
    'SOD_VIOLATION_DETECTED':         'governance.sod_violation.detected',

    // ─── Billing ──────────────────────────────────────────────────────
    'BILLING_UPGRADE_INITIATED':      'billing.upgrade.initiated',
    'BILLING_UPGRADE_COMPLETED':      'billing.upgrade.completed',
    'BILLING_DOWNGRADE_COMPLETED':    'billing.downgrade.completed',
    'BILLING_DOWNGRADE_BLOCKED':      'billing.downgrade.blocked',
    'BILLING_PAYMENT_SUCCEEDED':      'billing.payment.succeeded',
    'BILLING_PAYMENT_FAILED':         'billing.payment.failed',
    'BILLING_TRIAL_STARTED':          'billing.trial.started',
    'BILLING_TRIAL_ENDED':            'billing.trial.ended',
    'BILLING_TRIAL_CONVERTED':        'billing.trial.converted',

    // ─── SIEM ─────────────────────────────────────────────────────────
    'SIEM_CONFIG_UPDATED':            'siem.config.updated',
    'SIEM_TEST_SENT':                 'siem.config.test_sent',
    'SIEM_FORWARDING_ERROR':          'siem.forwarding.error',
    'SIEM_FORWARDING_DISABLED':       'siem.forwarding.disabled',

    // ─── Bulk Import ─────────────────────────────────────────────────
    'BULK_IMPORT_COMPLETED':          'admin.bulk_import.completed',

    // ─── Auto-Remediation ───────────────────────────────────────────
    'REMEDIATION_EVALUATED':          'remediation.evaluated',
    'REMEDIATION_AUTO_EXECUTED':      'remediation.auto_executed',
    'REMEDIATION_WORKFLOW_CREATED':   'remediation.workflow_created',
    'REMEDIATION_MANUAL_RECOMMENDED': 'remediation.manual_recommended',
    'REMEDIATION_SCHEDULED':          'remediation.scheduled',
    'REMEDIATION_COMPLETED':          'remediation.completed',
    'REMEDIATION_FAILED':             'remediation.failed',
    'REMEDIATION_REVERTED':           'remediation.reverted',
    'REMEDIATION_CANCELLED':          'remediation.cancelled',
    'REMEDIATION_RATE_LIMITED':       'remediation.rate_limited',
    'REMEDIATION_DRY_RUN':            'remediation.dry_run',
  };

  return MAP[legacyEvent] || `legacy.${legacyEvent.toLowerCase().replace(/_/g, '.')}`;
}
