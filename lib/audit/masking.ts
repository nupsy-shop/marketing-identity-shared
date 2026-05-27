/**
 * Read-time PII masking for audit events.
 *
 * Per the audit-settings spec §2.6, the canonical event payload in Postgres
 * (hash chain) and MinIO (WORM body) is always stored RAW — masking is a
 * read-time projection driven by `agency_settings.audit_masking` plus the
 * caller's viewer context. Credentials are always redacted at publish-time
 * by the publisher (separate concern); this module handles PII fields.
 *
 * Pure function. No IO. No DB calls. The caller (API route, export job)
 * is responsible for loading the agency's masking settings and salt and
 * deciding the viewer context.
 */

import crypto from 'crypto';

export type PiiMode = 'off' | 'exports' | 'all';
export type ViewerContext = 'viewer' | 'export' | 'auditor';

export interface MaskingSettings {
  piiMode: PiiMode;
  stripBodiesOnFailure: boolean;       // unused at read-time; here for shape parity with DB
  anonymizeAuditor: boolean;
}

export interface MaskedEvent {
  eventId: string;
  timestamp: string;
  eventType: string;
  severity: 'info' | 'warning' | 'critical';
  source: string;
  actor: { id?: string; email?: string; name?: string; ip?: string; type?: string };
  agency: { id: string; slug?: string };
  resource?: { type?: string; id?: string; name?: string };
  context?: Record<string, unknown>;
}

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const IPV4_REGEX = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

const REDACT_EMAIL = '[redacted-email]';
const REDACT_IP = '[redacted-ip]';
const REDACT_GENERIC = '[redacted]';

export function applyMask(
  events: MaskedEvent[],
  settings: MaskingSettings,
  viewer: ViewerContext,
  agencySalt: string,
): MaskedEvent[] {
  if (events.length === 0) return [];
  const piiActive = isPiiMaskingActive(settings.piiMode, viewer);
  return events.map((e) => maskOne(e, settings, viewer, agencySalt, piiActive));
}

function isPiiMaskingActive(mode: PiiMode, viewer: ViewerContext): boolean {
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  // mode === 'exports' → mask when viewer is export OR auditor (anything non-interactive)
  return viewer === 'export' || viewer === 'auditor';
}

function maskOne(
  e: MaskedEvent,
  settings: MaskingSettings,
  viewer: ViewerContext,
  agencySalt: string,
  piiActive: boolean,
): MaskedEvent {
  const actor = { ...e.actor };

  // PII redactions
  if (piiActive) {
    if (actor.email) actor.email = REDACT_EMAIL;
    if (actor.ip) actor.ip = REDACT_IP;
    if (actor.name) actor.name = REDACT_GENERIC;
  }

  // Auditor anonymization (orthogonal to piiMode — applies on top)
  if (viewer === 'auditor' && settings.anonymizeAuditor && actor.id) {
    actor.name = hashActor(actor.id, agencySalt);
  }

  let resource = e.resource;
  if (piiActive && resource?.type === 'user' && resource.name) {
    resource = { ...resource, name: REDACT_GENERIC };
  }

  let context = e.context;
  if (piiActive && context) {
    context = redactFreeText(context);
  }

  return { ...e, actor, resource, context };
}

function hashActor(actorId: string, agencySalt: string): string {
  return crypto.createHash('sha256').update(`${actorId}:${agencySalt}`).digest('hex').slice(0, 16);
}

function redactFreeText(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') {
      out[k] = v.replace(EMAIL_REGEX, REDACT_EMAIL).replace(IPV4_REGEX, REDACT_IP);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = redactFreeText(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
