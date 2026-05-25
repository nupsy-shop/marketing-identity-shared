/**
 * Notification Dispatch — Shared Library
 *
 * Single entry point for emitting domain events that route to an agency's
 * configured `notification_channels`. Channels are the operator-facing
 * contract at /admin/settings/notifications: each channel subscribes to a
 * set of event patterns (exact or `prefix.*`) and carries its own type and
 * config (email / slack / in-app / webhook).
 *
 * dispatchNotification runs in both the web app and the Bull worker, so
 * JML and other background producers can emit events without knowing which
 * channels (if any) the agency has configured. The dispatcher writes
 * in-app rows inline (synchronous, cheap) and enqueues jobs for outbound
 * channels (async delivery with retries on the `notifications` queue).
 *
 * Event naming convention: dot-namespaced, lowercase — e.g.
 * `jml.joiner`, `jml.leaver`, `directory.sync.failed`.
 */

import { getRuntime } from '../runtime.js';
import { recordTestDispatch } from './dispatch-capture.js';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface DispatchContext {
  /** Stable identifier of the subject (email, user id, resource id). */
  principal?: string;
  /** Short human-readable title; plugins may override based on event. */
  title?: string;
  /** Body copy; plugins may template over `context`. */
  body?: string;
  /** info | warning | critical. Defaults to info. */
  severity?: 'info' | 'warning' | 'critical';
  /** Structured data available to plugin formatters. */
  [key: string]: unknown;
}

interface ChannelRow {
  id: string;
  name: string;
  type: string;
  config: unknown;
  enabled_events: string[];
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Route `eventType` to every active channel that subscribes to it for the
 * given agency. Silent no-op when nothing subscribes. Per-channel delivery
 * errors are logged and swallowed so one bad channel can't block the
 * producer.
 */
export async function dispatchNotification(
  agencyId: string,
  eventType: string,
  context: DispatchContext,
): Promise<{ matched: number; dispatched: number }> {
  const { prisma, logger, enqueueJob } = getRuntime();

  let channels: ChannelRow[] = [];
  try {
    channels = await prisma.notification_channels.findMany({
      where: { agency_id: agencyId, is_active: true },
      select: {
        id: true,
        name: true,
        type: true,
        config: true,
        enabled_events: true,
      },
    });
  } catch (err) {
    logger.warn('[dispatchNotification] failed to load channels', {
      agencyId, eventType, error: (err as Error).message,
    });
    return { matched: 0, dispatched: 0 };
  }

  // In-app channels are implicitly subscribed to every event type. The
  // in-app plugin is auto-provisioned per agency and cannot be disabled or
  // deleted (see app/api/auth/create-agency/route.ts and PUT/DELETE guards
  // in app/api/settings/notifications/[id]/route.ts), so we bypass the
  // subscription join for it. This keeps coverage complete as new event
  // types are added — no backfill migration needed.
  const matched = channels.filter((c) =>
    isInAppChannel(c.type) || matchesSubscription(c.enabled_events, eventType),
  );
  if (matched.length === 0) return { matched: 0, dispatched: 0 };

  let dispatched = 0;
  for (const channel of matched) {
    await recordTestDispatch({
      agencyId, eventType, channelId: channel.id, channelType: channel.type, status: 'matched',
    }).catch(() => {});
    try {
      const ok = await routeChannel(channel, agencyId, eventType, context);
      if (ok) dispatched++;
    } catch (err) {
      logger.warn('[dispatchNotification] channel delivery failed', {
        agencyId, eventType, channelId: channel.id, error: (err as Error).message,
      });
    }
  }

  logger.info('[dispatchNotification] routed', {
    agencyId, eventType, matched: matched.length, dispatched,
  });

  return { matched: matched.length, dispatched };

  // ── per-channel routing ────────────────────────────────────────────────
  async function routeChannel(
    channel: ChannelRow,
    agencyId: string,
    eventType: string,
    context: DispatchContext,
  ): Promise<boolean> {
    switch (channel.type) {
      case 'in-app':
      case 'in_app':
        return writeInAppRows(agencyId, eventType, context);

      case 'email': {
        if (!enqueueJob) return false;
        const id = await enqueueJob('email_send', {
          tenantId: agencyId,
          channelId: channel.id,
          eventType,
          context,
        });
        return Boolean(id);
      }

      case 'slack': {
        if (!enqueueJob) return false;
        const id = await enqueueJob('slack_notify', {
          tenantId: agencyId,
          channelId: channel.id,
          eventType,
          context,
        });
        return Boolean(id);
      }

      case 'webhook': {
        if (!enqueueJob) return false;
        const id = await enqueueJob('webhook_deliver', {
          tenantId: agencyId,
          channelId: channel.id,
          eventType,
          context,
        });
        return Boolean(id);
      }

      default:
        logger.warn('[dispatchNotification] unknown channel type', {
          agencyId, eventType, channelId: channel.id, type: channel.type,
        });
        return false;
    }
  }

  async function writeInAppRows(
    agencyId: string,
    eventType: string,
    context: DispatchContext,
  ): Promise<boolean> {
    const admins: Array<{ id: string }> = await prisma.users.findMany({
      where: {
        agency_id: agencyId,
        is_active: true,
        role: { in: ['agency_admin', 'agency_owner'] },
      },
      select: { id: true },
    });
    if (admins.length === 0) return false;

    const title = context.title ?? defaultTitle(eventType);
    const body = context.body ?? defaultBody(eventType, context);
    const severity = context.severity ?? 'info';

    await prisma.in_app_notifications.createMany({
      data: admins.map((a) => ({
        agency_id: agencyId,
        user_id: a.id,
        event: eventType,
        title,
        body,
        severity,
        payload: context as unknown as object,
      })),
    });
    return true;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isInAppChannel(type: string | undefined | null): boolean {
  return type === 'in-app' || type === 'in_app';
}

function matchesSubscription(patterns: string[], eventType: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('.*')) {
      return eventType.startsWith(pattern.slice(0, -2));
    }
    return pattern === eventType;
  });
}

function defaultTitle(eventType: string): string {
  const last = eventType.split('.').pop() ?? eventType;
  return last.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function defaultBody(eventType: string, context: DispatchContext): string {
  const count = typeof context.count === 'number' ? context.count : undefined;
  const source = typeof context.pluginKey === 'string' ? context.pluginKey : undefined;
  if (count !== undefined && source) {
    return `${count} ${eventType} event${count === 1 ? '' : 's'} from ${source}.`;
  }
  return `Event ${eventType} occurred.`;
}
