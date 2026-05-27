/**
 * CEF (Common Event Format) Mapper
 *
 * Converts unified audit events to CEF format strings for ArcSight
 * and other CEF-native SIEM systems.
 *
 * CEF header: CEF:0|AccessHive|IdentityGovernance|1.0|{eventType}|{title}|{severity}|
 * Extension fields map from the unified audit schema.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

type AuditSeverity = 'info' | 'warning' | 'critical';

interface AuditActor {
  ip?: string;
  email?: string;
}

interface AuditResource {
  id?: string;
  name?: string;
}

interface AuditAgency {
  slug?: string;
}

export interface AuditEvent {
  eventType?: string;
  eventId?: string;
  severity?: AuditSeverity | string;
  timestamp?: string;
  source?: string;
  actor?: AuditActor;
  resource?: AuditResource;
  agency?: AuditAgency;
  _cefPayload?: string;
  [key: string]: unknown;
}

// ─── Severity Mapping ────────────────────────────────────────────────────────

const SEVERITY_MAP: Record<AuditSeverity, number> = {
  info: 1,
  warning: 5,
  critical: 8,
};

export function mapSeverity(auditSeverity: string): number {
  return SEVERITY_MAP[auditSeverity as AuditSeverity] || 1;
}

// ─── Human-Readable Message Generation ───────────────────────────────────────

const MESSAGE_MAP: Record<string, string> = {
  'access.request.created': 'Access request created',
  'access.request.approved': 'Access request approved',
  'access.request.completed': 'Access request completed',
  'access.request.cancelled': 'Access request cancelled',
  'access.request.rejected': 'Access request rejected',
  'access.item.created': 'Access item created',
  'access.item.updated': 'Access item updated',
  'access.item.deleted': 'Access item deleted',
  'access.item.validated': 'Access item validated',
  'access.item.verified': 'Access item verified',
  'access.granted': 'Access granted',
  'access.revoked': 'Access revoked',
  'identity.created': 'Identity created',
  'identity.updated': 'Identity updated',
  'identity.deleted': 'Identity deleted',
  'identity.toggled': 'Identity toggled',
  'identity.dedicated.provisioned': 'Identity provisioned',
  'pam.session.checkout': 'PAM session checked out',
  'pam.session.checkin': 'PAM session checked in',
  'pam.session.expired': 'PAM session expired',
  'pam.session.force_terminated': 'PAM session force terminated',
  'pam.approval.requested': 'PAM approval requested',
  'pam.approval.approved': 'PAM approval approved',
  'pam.approval.denied': 'PAM approval denied',
  'admin.client.created': 'Client created',
  'admin.client.updated': 'Client updated',
  'admin.client.deleted': 'Client deleted',
  'admin.platform.added': 'Platform added',
  'admin.platform.removed': 'Platform removed',
  'admin.settings.updated': 'Settings updated',
  'admin.user.invited': 'User invited',
  'admin.user.updated': 'User updated',
  'admin.user.deactivated': 'User deactivated',
  'admin.role.assigned': 'Role assigned',
  'admin.role_template.created': 'Role template created',
  'admin.role_template.updated': 'Role template updated',
  'admin.role_template.deleted': 'Role template deleted',
  'credential.saved': 'Credential saved',
  'credential.rotated': 'Credential rotated',
  'credential.revealed': 'Credential revealed',
  'credential.breakglass.revealed': 'Break-glass credential revealed',
  'credential.breakglass.rotated': 'Break-glass credential rotated',
  'auth.login.success': 'User logged in',
  'auth.login.failed': 'Login failed',
  'siem.config.updated': 'SIEM configuration updated',
  'siem.config.test_sent': 'SIEM test event sent',
  'siem.forwarding.started': 'SIEM forwarding started',
  'siem.forwarding.stopped': 'SIEM forwarding stopped',
  'siem.forwarding.error': 'SIEM forwarding error',
  'siem.forwarding.disabled': 'SIEM forwarding auto-disabled',
  'system.siem.test': 'SIEM Integration Test',
};

export function generateMessage(event: AuditEvent): string {
  const msg = MESSAGE_MAP[event.eventType || ''];
  if (msg) return msg;

  // Fallback: convert dot notation to sentence
  const parts = (event.eventType || 'unknown.event').split('.');
  const meaningful = parts.length > 2 ? parts.slice(1) : parts;
  return meaningful
    .map((p, i) => (i === 0 ? p.charAt(0).toUpperCase() + p.slice(1) : p.replace(/_/g, ' ')))
    .join(' ');
}

// ─── CEF Extension Escaping ──────────────────────────────────────────────────

function escapeCefValue(val: string | number | null | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\n/g, '\\n');
}

function escapeCefHeader(val: string | null | undefined): string {
  if (val === null || val === undefined) return '';
  return String(val).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

// ─── Outcome Detection ───────────────────────────────────────────────────────

function computeOutcome(event: AuditEvent): 'success' | 'failure' {
  const et = event.eventType || '';
  if (et.includes('failed') || et.includes('denied') || et.includes('rejected') || et.includes('error') || et.includes('disabled')) {
    return 'failure';
  }
  return 'success';
}

// ─── Title Generation ────────────────────────────────────────────────────────

function generateTitle(event: AuditEvent): string {
  return generateMessage(event);
}

// ─── Main Mapper ─────────────────────────────────────────────────────────────

/**
 * Convert a unified audit event to a CEF format string.
 */
export function mapEventToCef(event: AuditEvent): string {
  const severity = mapSeverity(event.severity || 'info');
  const title = escapeCefHeader(generateTitle(event));
  const eventType = escapeCefHeader(event.eventType || 'unknown');

  // CEF header
  const header = `CEF:0|AccessHive|IdentityGovernance|1.0|${eventType}|${title}|${severity}|`;

  // Extension fields
  const extensions: string[] = [];

  // Source IP
  if (event.actor?.ip) {
    extensions.push(`src=${escapeCefValue(event.actor.ip)}`);
  }

  // Source user (actor)
  if (event.actor?.email) {
    extensions.push(`suser=${escapeCefValue(event.actor.email)}`);
  }

  // Destination resource
  if (event.resource?.id) {
    extensions.push(`dst=${escapeCefValue(event.resource.id)}`);
  }
  if (event.resource?.name) {
    extensions.push(`duser=${escapeCefValue(event.resource.name)}`);
  }

  // Custom string 1: Agency
  if (event.agency?.slug) {
    extensions.push(`cs1=${escapeCefValue(event.agency.slug)}`);
    extensions.push(`cs1Label=Agency`);
  }

  // Custom string 2: Event source
  if (event.source) {
    extensions.push(`cs2=${escapeCefValue(event.source)}`);
    extensions.push(`cs2Label=EventSource`);
  }

  // Category
  extensions.push(`cat=${escapeCefValue(event.eventType)}`);

  // Receipt time (epoch milliseconds)
  const ts = event.timestamp ? new Date(event.timestamp).getTime() : Date.now();
  extensions.push(`rt=${ts}`);

  // Human-readable message
  extensions.push(`msg=${escapeCefValue(generateMessage(event))}`);

  // Outcome
  extensions.push(`outcome=${computeOutcome(event)}`);

  // Device external ID (event UUID)
  if (event.eventId) {
    extensions.push(`deviceExternalId=${escapeCefValue(event.eventId)}`);
  }

  return header + extensions.join(' ');
}
