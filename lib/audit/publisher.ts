/**
 * Audit Event Publisher (Phase-1A — Postgres-as-SoT).
 *
 * Publish path:
 *   1. In-memory buffer (existing 50-event / 2-sec window — preserved).
 *   2. Flush:
 *      a. PUT bodies to MinIO with Object Lock 7y. WORM happens here.
 *      b. PG transaction per agency: SELECT MAX(seq), INSERT chain rows
 *         with prev_hash chain, retry on PK conflict.
 *      c. Enqueue ES-indexing Bull jobs (best-effort, post-commit).
 *
 * Chain integrity guarantee: the PK (agency_id, seq) is the atomic CAS.
 * Concurrent writers race; the loser retries from the new MAX(seq) and
 * recomputes its event hashes against the winner's tail. No advisory
 * locks. No in-memory state to drift across dynos. No fork possible.
 *
 * Caller contract (unchanged from prior version):
 *   - publishAuditEvent({...}) is fire-and-forget; callers add .catch(() => {}).
 *   - Buffer flushes every 2s or at 50 events. Use flushAll() to drain
 *     before process exit.
 */
import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { getRuntime } from '../runtime.js';
import { canonicalizeBody, sha256Hex } from './canonicalize.js';
import { putAuditBody, auditBodyKey } from './minio-archive.js';
import { enqueueForwardJobs } from './forward-dispatch.js';
import { resolveIdentityIdByEmail, deriveOccurredAt, deriveAttribution } from './correlation.js';
import type { AuditEvent } from '../../plugins/audit-destinations/common/audit-destination-plugin.interface.js';

// ─── Body-strip on failure (publish-time redaction) ─────────────────────────
//
// When `agency_settings.audit_masking.stripBodiesOnFailure === true` and the
// event's `context.outcome === 'failure'`, replace `context.body` with the
// sentinel '[stripped]' BEFORE canonicalization. This is the only place a
// write can be redacted before being chained — read-time masking can't
// touch the WORM body or the hash chain.
//
// Settings are cached per-process with a 60s TTL to avoid hammering Postgres
// on every publish. Cache is keyed by agencyId; falls back to "don't strip"
// on any lookup error so the publish path stays non-blocking.

interface MaskingCacheEntry {
  stripBodiesOnFailure: boolean;
  expiresAt: number;
}
const MASKING_CACHE_TTL_MS = 60_000;
const _maskingCache = new Map<string, MaskingCacheEntry>();
const STRIPPED_BODY_SENTINEL = '[stripped]';

async function getStripBodiesOnFailure(agencyId: string): Promise<boolean> {
  const now = Date.now();
  const cached = _maskingCache.get(agencyId);
  if (cached && cached.expiresAt > now) return cached.stripBodiesOnFailure;

  const { prisma } = getRuntime();
  if (!prisma?.agency_settings?.findUnique) {
    // Runtime may not register prisma in some test contexts; default to false.
    return false;
  }
  let stripBodiesOnFailure = false;
  try {
    const row = await prisma.agency_settings.findUnique({
      where: { agency_id: agencyId },
      select: { audit_masking: true },
    });
    const masking = row?.audit_masking;
    if (masking && typeof masking === 'object' && masking.stripBodiesOnFailure === true) {
      stripBodiesOnFailure = true;
    }
  } catch (err) {
    // Don't block publish on settings-lookup failure; cache the negative
    // briefly so we don't retry on every call.
    console.warn('[Audit] masking-settings lookup failed:', (err as Error).message);
  }
  _maskingCache.set(agencyId, { stripBodiesOnFailure, expiresAt: now + MASKING_CACHE_TTL_MS });
  return stripBodiesOnFailure;
}

async function maybeStripBody(input: AuditEventPayload, agencyId: string): Promise<AuditEventPayload> {
  const ctx = input.context;
  if (!ctx || typeof ctx !== 'object') return input;
  if ((ctx as Record<string, unknown>).outcome !== 'failure') return input;
  if (!('body' in ctx)) return input;
  const strip = await getStripBodiesOnFailure(agencyId);
  if (!strip) return input;
  return {
    ...input,
    context: { ...ctx, body: STRIPPED_BODY_SENTINEL },
  };
}

// Test seam.
export function __resetMaskingCacheForTest(): void {
  _maskingCache.clear();
}

// ─── Public input contract (preserved) ──────────────────────────────────────

export interface AuditEventPayload {
  type?: string;
  eventType?: string;
  action?: string;
  source?: string;
  severity?: string;
  actor?: { id: string | null; email?: string | null; name?: string | null; type?: string; ip?: string | null; [k: string]: unknown };
  target?: { id: string | null; type: string; name?: string | null };
  resource?: { type?: string; id?: string | null; name?: string | null };
  agency?: { id: string | null; slug?: string | null };
  client?: { id: string | null; name?: string | null };
  context?: Record<string, unknown>;
  agency_id?: string | null;
  timestamp?: Date | string;
  [k: string]: unknown;
}

interface PreparedEvent {
  eventId: string;       // UUID
  agencyId: string;      // required for chain
  timestamp: Date;
  bodyBytes: Buffer;     // RFC 8785 JCS bytes
  bodySha256: string;    // hex
  /**
   * Plugin-facing event shape, built alongside the canonical body. Used
   * by forward-dispatch / per-destination filters at flush time.
   * Kept on the PreparedEvent so we don't re-parse the canonical JSON
   * (which would lose typing) and don't snapshot the full input payload
   * (which carries unbounded `context`).
   */
  forwardable: AuditEvent;
}

// ─── Buffer ──────────────────────────────────────────────────────────────────

const BUFFER_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;
const GENESIS_PREV_HASH = '0'.repeat(64);

let _buffer: PreparedEvent[] = [];
let _flushTimer: ReturnType<typeof setInterval> | null = null;
let _initialized = false;

function startFlushTimer(): void {
  if (_flushTimer) return;
  _flushTimer = setInterval(() => {
    if (_buffer.length > 0) {
      flush().catch(err => console.error('[Audit] flush error:', (err as Error).message));
    }
  }, FLUSH_INTERVAL_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

function init(): void {
  if (_initialized) return;
  _initialized = true;
  startFlushTimer();
}

// ─── Prepare (per-event, in caller's tick) ──────────────────────────────────

function prepareEvent(input: AuditEventPayload): PreparedEvent | null {
  // Accept all three forms: { agency: { id } }, { agency_id }, { agencyId }.
  // The bull worker's job-lifecycle audit passes top-level agencyId.
  const inputAgencyId = (input as Record<string, unknown>).agencyId;
  const agencyId = input.agency?.id
    ?? input.agency_id
    ?? (typeof inputAgencyId === 'string' ? inputAgencyId : null)
    ?? null;
  if (!agencyId) {
    // System-level (un-chained) events are dropped in Phase-1A. Document
    // this in the runbook; today's existing system-events fall into a
    // narrow set of cleanup/cron paths and they tolerate loss.
    console.warn('[Audit] dropping un-chained event (no agency_id):', input.eventType ?? input.type);
    return null;
  }
  const eventId = crypto.randomUUID();
  const timestamp = new Date();

  const eventType = input.eventType ?? input.type ?? 'unknown';
  const source = input.source ?? 'accesshive';
  const severityIn = input.severity ?? 'info';
  // Narrow severity to the AuditDestination filter enum. Unknown values
  // collapse to 'info' so a typo in a publish call cannot accidentally
  // hide events from a destination's minSeverity filter.
  const severity: AuditEvent['severity'] =
    severityIn === 'warning' || severityIn === 'critical' ? severityIn : 'info';

  const canonical = canonicalizeBody({
    eventId,
    timestamp: timestamp.toISOString(),
    eventType,
    source,
    severity,
    actor: {
      id: input.actor?.id ?? null,
      email: input.actor?.email ?? null,
      type: input.actor?.type ?? 'user',
      ip: input.actor?.ip ?? null,
    },
    agency: { id: agencyId, slug: input.agency?.slug ?? null },
    resource: input.resource ?? null,
    context: input.context ?? {},
  });
  const bodyBytes = Buffer.from(canonical, 'utf8');

  const forwardable: AuditEvent = {
    eventId,
    timestamp: timestamp.toISOString(),
    eventType,
    severity,
    source,
    actor: {
      ...(input.actor?.id    ? { id:    input.actor.id    } : {}),
      ...(input.actor?.email ? { email: input.actor.email } : {}),
      ...(input.actor?.name  ? { name:  input.actor.name  } : {}),
      ...(input.actor?.type  ? { type:  input.actor.type  } : {}),
    },
    agency: {
      id: agencyId,
      ...(input.agency?.slug ? { slug: input.agency.slug } : {}),
    },
    ...(input.resource
      ? {
          resource: {
            ...(input.resource.type ? { type: input.resource.type } : {}),
            ...(input.resource.id   ? { id:   input.resource.id   } : {}),
            ...(input.resource.name ? { name: input.resource.name } : {}),
          },
        }
      : {}),
    ...(input.context ? { context: input.context } : {}),
  };

  return {
    eventId,
    agencyId,
    timestamp,
    bodyBytes,
    bodySha256: sha256Hex(bodyBytes),
    forwardable,
  };
}

// ─── Flush ──────────────────────────────────────────────────────────────────

async function flush(): Promise<void> {
  if (_buffer.length === 0) return;
  const batch = _buffer.splice(0);

  // 1. WORM body in MinIO. Failure aborts the flush; PG is untouched.
  await Promise.all(batch.map(e => putAuditBody({
    agencyId: e.agencyId,
    eventId: e.eventId,
    body: e.bodyBytes,
  })));

  // 2. Chain insert per agency.
  const byAgency = new Map<string, PreparedEvent[]>();
  for (const e of batch) {
    const arr = byAgency.get(e.agencyId) ?? [];
    arr.push(e);
    byAgency.set(e.agencyId, arr);
  }
  for (const [agencyId, events] of byAgency) {
    await insertChainBatch(agencyId, events);
  }

  // 2.5. Read projection (audit_events_mirror). Best-effort and INTENTIONALLY
  // outside the chain transaction: the hash chain + S3 body are the source of
  // truth and must never be blocked or rolled back by a derived read model.
  // This projection gives resource-scoped reads (getActivityForResource and
  // every queryAuditEvents resource filter) a queryable Postgres source that
  // does not depend on the capacity-capped Searchly cluster, whose index limit
  // silently drops new events (#1766 / #1924). A failure here leaves the chain
  // intact and is recoverable by replaying bodies from S3.
  await writeProjectionBatch(batch).catch(err =>
    console.warn('[Audit] read-projection write failed (non-fatal):', (err as Error).message));

  // 3. Enqueue ES indexing — fire-and-forget. The audit chain commit
  // (step 2) is the synchronous side channel callers observe; ES is a
  // downstream read-path optimization that can fail independently
  // without affecting chain integrity. If we await here, a stuck
  // Bull/Redis connection blocks the route handler past Heroku's H12
  // 30s cap.
  const { enqueueJob } = getRuntime();
  if (enqueueJob) {
    for (const e of batch) {
      void enqueueJob('audit_index_es', { eventId: e.eventId }).catch((err: unknown) => {
        console.warn('[Audit] ES-indexing enqueue failed:', (err as Error).message);
      });
    }
  }

  // 4. Fan out to audit-destination forwarders per agency. Fire-and-forget;
  //    delivery failures surface via destination row counters (recordFailure),
  //    not via this code path. Never block or throw out of the publisher.
  for (const [agencyId, events] of byAgency) {
    enqueueForwardJobs(agencyId, events.map(e => e.forwardable))
      .catch(err => console.warn('[Audit] enqueueForwardJobs failed:', (err as Error).message));
  }
}

// ─── Read projection (audit_events_mirror) ──────────────────────────────────
//
// Denormalized, queryable copy of each event for resource-scoped reads. Written
// in ALL environments (the table used to be E2E-only) so that getActivityFor
// resource / queryAuditEvents resource filters have a Postgres source that does
// not depend on Searchly. Best-effort: never throws into flush(). Prod rows
// carry an empty e2eTag; E2E synthetic rows (written by tests/support/audit-
// writer.ts) carry their scenario tag.
async function writeProjectionBatch(events: PreparedEvent[]): Promise<void> {
  const { prisma } = getRuntime();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mirror = (prisma as any)?.auditEventsMirror;
  if (!mirror) return; // delegate/table not present in this environment

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = await Promise.all(events.map(async e => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const f = e.forwardable as any;
    const ctx = (f.context ?? {}) as Record<string, unknown>;

    // session_grant_id is a FIRST-PARTY fact only when AccessHive emitted it
    // (lifecycle / brokered writes). Never resolved from external data.
    const sessionGrantId =
      typeof ctx.session_grant_id === 'string' ? ctx.session_grant_id
      : typeof ctx.grantId === 'string' ? ctx.grantId
      : null;

    // identity_id is resolved ONLY for external events (no grant). For bound
    // events the actor is the human operator, not the synthetic identity, so we
    // never resolve it there.
    let identityId: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (!sessionGrantId) {
      identityId = await resolveIdentityIdByEmail(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        prisma as any,
        e.agencyId,
        f.actor?.email ?? null,
      );
    }

    return {
      agencyId: e.agencyId,
      eventType: f.eventType,
      action: f.action ?? f.eventType,
      severity: f.severity ?? 'info',
      source: f.source ?? 'accesshive',
      actorId: f.actor?.id ?? null,
      actorEmail: f.actor?.email ?? null,
      resourceId: f.resource?.id ?? null,
      resourceType: f.resource?.type ?? null,
      payload: f as Record<string, unknown>,
      e2eTag: '',
      capturedAt: e.timestamp,
      // ── correlation index ──
      identityId,
      sessionGrantId,
      // Persist the event's top-level client.id verbatim (set on the forwardable
      // in buildForwardable when details.clientId is present). This is the TRUE
      // client id, independent of the resource-demotion logic — so the dashboard
      // mirror reader matches the same set as the ES `client.id` term, with no
      // resourceType='client' undercount. (#2360)
      clientId: f.client?.id ?? null,
      occurredAt: deriveOccurredAt(ctx, e.timestamp),
      attribution: deriveAttribution(sessionGrantId, identityId),
    };
  }));
  await mirror.createMany({ data });
}

// Test seam — exercises the correlation logic without the buffer/flush machinery.
export async function __writeProjectionBatchForTest(events: PreparedEvent[]): Promise<void> {
  return writeProjectionBatch(events);
}

// ─── Chain insert with PK retry ─────────────────────────────────────────────

const MAX_PK_RETRIES = 5;

function isPrimaryKeyConflict(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2002';
  // Also handle plain error objects from mocks / non-Prisma wrappers
  return (err as { code?: string })?.code === 'P2002';
}

function isSerializationFailure(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2034';
  return (err as { code?: string })?.code === 'P2034';
}

function jitterBackoff(attempt: number): Promise<void> {
  const base = 25 * Math.pow(2, attempt);   // 25, 50, 100, 200, 400 ms
  const ms = base + Math.floor(Math.random() * base);
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function insertChainBatch(agencyId: string, events: PreparedEvent[]): Promise<void> {
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  for (let attempt = 0; attempt < MAX_PK_RETRIES; attempt++) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.$transaction(async (tx: any) => {
        const head = await tx.auditEvent.findFirst({
          where:   { agencyId },
          orderBy: { seq: 'desc' },
          select:  { seq: true, eventHash: true },
        });
        let prevHash = head?.eventHash ?? GENESIS_PREV_HASH;
        let nextSeq  = (head?.seq ?? 0n) + 1n;

        const rows = events.map(e => {
          const eventHash = sha256Hex(Buffer.concat([
            Buffer.from(prevHash, 'hex'),
            e.bodyBytes,
          ]));
          const row = {
            agencyId, seq: nextSeq, prevHash, eventHash,
            eventId: e.eventId, timestamp: e.timestamp,
            bodyS3Key: auditBodyKey(agencyId, e.eventId),
            bodySha256: e.bodySha256,
            // Populate the indexed `event_type` column so eventType-scoped
            // reads (queryAuditEvents, the @BSCaseID=1430 freshness probe,
            // SIEM index filters) can find the row without round-tripping
            // through the WORM body. Without this, the column defaults to
            // '' for every chain row and `where: { eventType: '<dotted>' }`
            // returns zero matches even though the mirror has the event.
            eventType: e.forwardable.eventType,
          };
          prevHash = eventHash;
          nextSeq += 1n;
          return row;
        });

        await tx.auditEvent.createMany({ data: rows });
        await tx.auditEsIndexState.createMany({
          data: rows.map(r => ({ eventId: r.eventId })),
        });
      }, {
        isolationLevel: 'Serializable',
        // Prisma defaults are too tight for the audit chain-write path under
        // realistic Heroku-PG WAN load: `timeout` defaults to 5_000ms (txn
        // body wall-clock) and `maxWait` defaults to 2_000ms (connection
        // acquisition from the Prisma pool). Both surface as P2028 with the
        // same message ("Unable to start a transaction in the given time"),
        // and we have observed the chain-write path block on connection
        // acquisition when other writers (audit-retention sweep, SCIM delta
        // replay, JML burst) saturate the pool. Bumping both gives us
        // headroom without changing isolation semantics. The retry loop
        // around this block still handles legitimate serialization
        // failures via `isSerializationFailure` / `isPrimaryKeyConflict`.
        timeout: 30_000,
        maxWait: 10_000,
      });
      return; // success
    } catch (err) {
      if ((isPrimaryKeyConflict(err) || isSerializationFailure(err)) && attempt < MAX_PK_RETRIES - 1) {
        await jitterBackoff(attempt);
        continue;
      }
      throw err;
    }
  }
  throw new Error(`[audit] chain insert exhausted ${MAX_PK_RETRIES} retries for agency ${agencyId}`);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Phase-1A: returns a handle with the eventId (known at publish time).
 * eventHash/prevHash are NOT available synchronously — they're computed
 * at flush time when the chain row is inserted. Callers that need the
 * hashes (e.g. E2E seed scripts) should call flushAll() and then query
 * `audit_events` by eventId.
 *
 * Returns null when the event was dropped (no agency_id).
 */
export async function publishAuditEvent(input: AuditEventPayload): Promise<{ eventId: string } | null> {
  init();
  // Body-strip on failure must run BEFORE canonicalization so the hash
  // chain reflects the stripped bytes. Resolve agency_id the same way
  // prepareEvent does so we don't strip for un-chained system events.
  const inputAgencyId = (input as Record<string, unknown>).agencyId;
  const agencyId = input.agency?.id
    ?? input.agency_id
    ?? (typeof inputAgencyId === 'string' ? inputAgencyId : null)
    ?? null;
  const stripped = agencyId ? await maybeStripBody(input, agencyId) : input;
  const prepared = prepareEvent(stripped);
  if (!prepared) return null;
  _buffer.push(prepared);
  if (_buffer.length >= BUFFER_SIZE) {
    flush().catch(err => console.error('[Audit] immediate flush error:', (err as Error).message));
  }
  return { eventId: prepared.eventId };
}

export async function flushAll(): Promise<void> {
  await flush();
}

// Test seam.
export function __resetPublisherForTest(): void {
  _buffer = [];
  if (_flushTimer) { clearInterval(_flushTimer); _flushTimer = null; }
  _initialized = false;
}

// ─── Legacy event mapping (preserved verbatim from prior version) ───────────

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

export async function publishLegacyEvent(
  params: LegacyEventParams | Record<string, unknown>,
): Promise<void> {
  const p = params as LegacyEventParams;
  const eventType = mapLegacyEventType(p.event || '');

  const resource: { type?: string; id?: string; name?: string } = {};
  if (p.requestId) { resource.type = 'access-request'; resource.id = p.requestId; }
  else if (p.itemId) { resource.type = 'access-item'; resource.id = p.itemId; }
  else if (p.platformId) { resource.type = 'platform'; resource.id = p.platformId; }
  else if (p.details?.identityId) { resource.type = 'identity'; resource.id = p.details.identityId as string; }
  else if (p.details?.clientId)  { resource.type = 'client';   resource.id = p.details.clientId as string; }
  else if (p.details?.userId)    { resource.type = 'user';     resource.id = p.details.userId as string; }
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

export function mapLegacyEventType(legacyEvent: string): string {
  // Verbatim copy of the MAP from the prior publisher.ts (lines 534–747).
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
    'IDENTITY_DEACTIVATED': 'identity.deactivated',
    'IDENTITY_DELETE_FAILED': 'identity.delete_failed',
    'IDENTITY_TEARDOWN_RETRIED': 'identity.teardown.retried',
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
    // Route handlers under app/api/pam emit these names (not the PAM_SESSION_*
    // names above) — alias them to the same canonical eventTypes the GDPR
    // report, session-recording UI, and SIEM CEF mapper read.
    'PAM_CHECKOUT': 'pam.session.checkout',
    'PAM_CHECKIN': 'pam.session.checkin',
    'PAM_FORCE_TERMINATE': 'pam.session.force_terminated',
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
    // Emitted by app/api/client-credentials/[id]/{save,rotate}; previously
    // fell through to legacy.client.credential.* which no reader queries.
    'CLIENT_CREDENTIAL_SAVED': 'credential.client.saved',
    'CLIENT_CREDENTIAL_ROTATED': 'credential.client.rotated',
    'PLATFORM_CREDENTIALS_SAVED': 'admin.platform.credentials_saved',
    'OAUTH_TOKEN_STORED': 'oauth.token.stored',
    'OAUTH_TARGET_SELECTED': 'oauth.target.selected',
    'OAUTH_TOKEN_UPDATED': 'oauth.token.updated',
    'ACCESS_GRANTED': 'access.granted',
    'ACCESS_REVOKED': 'access.revoked',
    'ACCESS_APPROVED': 'access.approved',
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
    'PAM_CHECKOUT_BLOCKED_IP': 'pam.checkout.blocked_ip',
    'PAM_APPROVAL_RESOLVED': 'pam.approval.resolved',
    'PAM_SESSION_REVOKED': 'pam.session.revoked',
    'USER_LOGIN': 'auth.login.success',
    'USER_LOGIN_FAILED': 'auth.login.failed',
    'USER_LOGOUT': 'auth.logout',
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

// Notification hook (preserved from prior version, unchanged).
// Uses `any[]` rather than `unknown[]` so callers can pass typed callback
// functions (TS function-parameter contravariance forbids strict-typed
// callbacks where `unknown[]` is expected).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _notificationHook: ((...args: any[]) => any) | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setNotificationHook(hookFn: (...args: any[]) => any): void {
  _notificationHook = hookFn;
}

// Keep _notificationHook used to suppress unused variable lint warnings.
// The hook is fired by callers externally; the publisher doesn't use it
// in Phase-1A but must preserve the API.
void _notificationHook;

// __resetHashChainStateForTest preserved as a no-op for any tests that still call it.
export function __resetHashChainStateForTest(): void { /* no-op */ }
