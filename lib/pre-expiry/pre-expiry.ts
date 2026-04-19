/**
 * Pre-expiry notifier (shared, per-agency) — issue #49.
 *
 * Hourly per-agency pass:
 *   1. Skip if the agency is not entitled to `features.timeBoundAccess`
 *      (optional caller-supplied gate). Emits EXACTLY ONE
 *      `PRE_EXPIRY_NOTICE_SKIPPED` audit per scan per non-entitled agency
 *      with reason `not_entitled` (never per-item).
 *   2. Resolve the agency's notice window from
 *      `agency_settings.time_bound_config.notifyBeforeDaysExpiry`
 *      (default 7, allow-listed to 1/3/7/14/30).
 *   3. Select `access_request_items` whose `expiresAt` is strictly in the
 *      future AND within the window AND not yet recorded in
 *      `access_request_item_expiry_notices`.
 *   4. For each item, reserve a dedup row (unique item_id+expires_at),
 *      then dispatch `access.expiration.expiring` through the agency's
 *      configured notification channels.
 *
 * Invariants:
 *   - Agency-scoped at every read/write.
 *   - Never mutates `access_request_items` — revocation owned by the
 *     separate enforce-access-expiry job.
 *   - Notification context carries IDs + timestamps only — no seed values,
 *     backup codes, passwords, or grant bodies.
 *   - Idempotent via `(item_id, expires_at)` unique key.
 *   - Partial-failure isolation — one channel's error never blocks another
 *     channel's delivery (dispatchNotification owns per-channel try/catch).
 *
 * Prisma only. No raw SQL.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';

// ─── Audit event names (stable) ────────────────────────────────────────────
export const PRE_EXPIRY_NOTICE_FIRED   = 'access.expiration.notice_fired';
export const PRE_EXPIRY_NOTICE_FAILED  = 'access.expiration.notice_failed';
export const PRE_EXPIRY_NOTICE_SKIPPED = 'access.expiration.notice_skipped';

// ─── Config ────────────────────────────────────────────────────────────────
export const PRE_EXPIRY_ALLOWED_WINDOWS: ReadonlyArray<number> = [1, 3, 7, 14, 30];
export const DEFAULT_NOTIFY_BEFORE_DAYS_EXPIRY = 7;

// ─── Types ─────────────────────────────────────────────────────────────────
export interface ExpiringItem {
  itemId: string;
  clientId: string;
  platformKey: string;
  expiresAt: Date;
  agencyId: string;
}

export interface PreExpiryNoticeContext {
  itemId: string;
  clientId: string;
  platformKey: string;
  expiresAt: string;
  daysAhead: number;
}

export interface AgencyScanResult {
  agencyId: string;
  scanned: number;
  dispatched: number;
  skipped: number;
  failed: number;
  entitled: boolean;
}

export interface RunPreExpiryOptions {
  agencyId: string;
  now?: Date;
  dryRun?: boolean;
  /** Optional entitlement gate — caller supplies. */
  isEntitled?: (agencyId: string) => Promise<boolean>;
  /**
   * Optional override of raw time_bound_config. When absent, helper reads
   * from `agency_settings.time_bound_config` itself.
   */
  rawTimeBoundConfig?: unknown;
}

// ─── Window math ───────────────────────────────────────────────────────────

export function resolveWindowDays(rawConfig: unknown): number {
  const cfg = (rawConfig || {}) as { notifyBeforeDaysExpiry?: number };
  const raw = cfg.notifyBeforeDaysExpiry;
  if (typeof raw === 'number' && PRE_EXPIRY_ALLOWED_WINDOWS.includes(raw)) {
    return raw;
  }
  return DEFAULT_NOTIFY_BEFORE_DAYS_EXPIRY;
}

export function daysAhead(expiresAt: Date, now: Date): number {
  const ms = expiresAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// ─── Selection ─────────────────────────────────────────────────────────────

export async function selectItemsToNotify(
  agencyId: string,
  windowDays: number,
  now: Date,
): Promise<ExpiringItem[]> {
  const { prisma } = getRuntime();
  const windowEnd = new Date(now.getTime() + windowDays * 86_400_000);

  const rows = await prisma.access_request_items.findMany({
    where: {
      agency_id: agencyId,
      status: 'validated',
      expiresAt: { gt: now, lte: windowEnd },
    },
    select: {
      id: true,
      expiresAt: true,
      agency_id: true,
      access_requests: { select: { clientId: true } },
      catalog_platforms: { select: { slug: true } },
    },
  });

  if (rows.length === 0) return [];

  const alreadyNotified = await prisma.access_request_item_expiry_notices.findMany({
    where: {
      agency_id: agencyId,
      item_id: { in: rows.map((r: { id: string }) => r.id) },
    },
    select: { item_id: true, expires_at: true },
  });
  const seen = new Set<string>(
    alreadyNotified.map((n: { item_id: string; expires_at: Date }) =>
      `${n.item_id}::${new Date(n.expires_at).toISOString()}`,
    ),
  );

  const out: ExpiringItem[] = [];
  for (const r of rows as Array<{
    id: string;
    expiresAt: Date | null;
    agency_id: string;
    access_requests: { clientId: string } | null;
    catalog_platforms: { slug: string | null } | null;
  }>) {
    if (!r.expiresAt) continue;
    const key = `${r.id}::${new Date(r.expiresAt).toISOString()}`;
    if (seen.has(key)) continue;
    out.push({
      itemId: r.id,
      clientId: r.access_requests?.clientId ?? '',
      platformKey: r.catalog_platforms?.slug ?? '',
      expiresAt: r.expiresAt,
      agencyId: r.agency_id,
    });
  }
  return out;
}

// ─── Dispatch ──────────────────────────────────────────────────────────────

export function buildContext(item: ExpiringItem, now: Date): PreExpiryNoticeContext {
  return {
    itemId: item.itemId,
    clientId: item.clientId,
    platformKey: item.platformKey,
    expiresAt: item.expiresAt.toISOString(),
    daysAhead: daysAhead(item.expiresAt, now),
  };
}

export async function dispatchExpiryNotice(
  agencyId: string,
  item: ExpiringItem,
  now: Date,
): Promise<boolean> {
  const { prisma, logger } = getRuntime();
  const ctx = buildContext(item, now);

  // Reserve the slot first — unique (item_id, expires_at) prevents double-fire.
  try {
    await prisma.access_request_item_expiry_notices.create({
      data: {
        item_id: item.itemId,
        expires_at: item.expiresAt,
        agency_id: agencyId,
        days_ahead: ctx.daysAhead,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/unique|duplicate/i.test(msg)) {
      logger.warn('pre-expiry: slot reservation failed', {
        itemId: item.itemId,
        err: msg,
      });
    }
    return false;
  }

  // Dispatch — the shared dispatcher loops per-channel and never throws;
  // it returns per-channel results for partial-failure observability.
  const dispatchResult = await dispatchNotification(
    agencyId,
    'access.expiration.expiring',
    ctx as unknown as Record<string, unknown>,
  );

  // Fire summary audit — IDs + counts only, never the notification body.
  await publishAuditEvent({
    eventType: PRE_EXPIRY_NOTICE_FIRED,
    source: 'pre-expiry-notifier',
    severity: 'info',
    agency: { id: agencyId },
    actor: { id: 'system:pre-expiry-notifier', type: 'system' },
    resource: { type: 'access_request_item', id: item.itemId },
    context: {
      itemId: item.itemId,
      clientId: item.clientId,
      platformKey: item.platformKey,
      expiresAt: ctx.expiresAt,
      daysAhead: ctx.daysAhead,
      matched: dispatchResult.matched,
      dispatched: dispatchResult.dispatched,
    },
  }).catch(() => { /* non-fatal */ });

  // `dispatchResult.dispatched === 0` with matched > 0 means every
  // subscribed channel errored — surface as a failed audit.
  if (dispatchResult.matched > 0 && dispatchResult.dispatched === 0) {
    await publishAuditEvent({
      eventType: PRE_EXPIRY_NOTICE_FAILED,
      source: 'pre-expiry-notifier',
      severity: 'warning',
      agency: { id: agencyId },
      actor: { id: 'system:pre-expiry-notifier', type: 'system' },
      resource: { type: 'access_request_item', id: item.itemId },
      context: {
        itemId: item.itemId,
        clientId: item.clientId,
        platformKey: item.platformKey,
        expiresAt: ctx.expiresAt,
        daysAhead: ctx.daysAhead,
        matched: dispatchResult.matched,
      },
    }).catch(() => { /* non-fatal */ });
    return false;
  }

  return dispatchResult.dispatched > 0;
}

// ─── Skip audit ────────────────────────────────────────────────────────────

export async function emitSkipped(
  agencyId: string,
  reason: 'not_entitled' | 'no_config',
): Promise<void> {
  await publishAuditEvent({
    eventType: PRE_EXPIRY_NOTICE_SKIPPED,
    source: 'pre-expiry-notifier',
    severity: 'info',
    agency: { id: agencyId },
    actor: { id: 'system:pre-expiry-notifier', type: 'system' },
    context: { reason },
  }).catch(() => { /* non-fatal */ });
}

// ─── Per-agency runner ─────────────────────────────────────────────────────

/**
 * Run the pre-expiry pipeline for a single agency. Callers are responsible
 * for any `withTenantContext` wrapping on the web side; in the worker the
 * helper runs without tenant middleware because Prisma queries already
 * filter on `agencyId`.
 */
export async function runPreExpiryNotifierForAgency(
  opts: RunPreExpiryOptions,
): Promise<AgencyScanResult> {
  const { prisma, logger } = getRuntime();
  const now = opts.now ?? new Date();
  const result: AgencyScanResult = {
    agencyId: opts.agencyId,
    scanned: 0,
    dispatched: 0,
    skipped: 0,
    failed: 0,
    entitled: true,
  };

  if (opts.isEntitled) {
    let entitled = false;
    try {
      entitled = await opts.isEntitled(opts.agencyId);
    } catch (err) {
      logger.warn('pre-expiry: entitlement resolve failed', {
        agencyId: opts.agencyId,
        err: err instanceof Error ? err.message : String(err),
      });
      entitled = false;
    }
    if (!entitled) {
      result.entitled = false;
      await emitSkipped(opts.agencyId, 'not_entitled');
      return result;
    }
  }

  // Window resolution — use caller-supplied config if provided, otherwise
  // read from agency_settings ourselves.
  let rawConfig = opts.rawTimeBoundConfig;
  if (rawConfig === undefined) {
    const settings = await prisma.agency_settings.findFirst({
      where: { agency_id: opts.agencyId },
      select: { time_bound_config: true },
    });
    rawConfig = settings?.time_bound_config;
  }
  const windowDays = resolveWindowDays(rawConfig);

  const items = await selectItemsToNotify(opts.agencyId, windowDays, now);
  result.scanned = items.length;
  if (items.length === 0) return result;

  for (const item of items) {
    if (opts.dryRun) continue;
    try {
      const ok = await dispatchExpiryNotice(opts.agencyId, item, now);
      if (ok) result.dispatched++;
      else result.failed++;
    } catch (err) {
      result.failed++;
      logger.error('pre-expiry: item dispatch threw', {
        agencyId: opts.agencyId,
        itemId: item.itemId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('pre-expiry: scan complete', {
    agencyId: opts.agencyId,
    windowDays,
    scanned: result.scanned,
    dispatched: result.dispatched,
    failed: result.failed,
  });

  return result;
}
