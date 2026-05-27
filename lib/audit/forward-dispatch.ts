/**
 * Audit-forward dispatch.
 *
 * Called by the publisher AFTER PG + ES enqueue. For each enabled
 * destination in the affected agency:
 *   1. Apply the destination's filters (matchesFilters).
 *   2. If any events pass, enqueue one `{plugin_key}_forward_batch` job
 *      with the surviving events.
 *
 * Fire-and-forget: the caller wraps the promise in `.catch(log)` so a
 * dispatch failure never blocks the publish path. Delivery failures
 * surface to the operator via the destination's
 * `consecutive_failures` / `last_error` counters (recordFailure).
 *
 * Bull retry is intentionally disabled on the AUDIT_FORWARDING queue
 * (attempts: 1 — set on the worker side). `recordFailure` owns retry
 * semantics; Bull retry would double-count.
 */

import { getRuntime } from '../runtime.js';
import { matchesFilters } from '../../plugins/audit-destinations/common/filters.js';
import type {
  AuditEvent,
  AuditDestinationFilters,
} from '../../plugins/audit-destinations/common/audit-destination-plugin.interface.js';

/**
 * `plugin_key` is kebab-case (e.g. 'cef-syslog'); the catalog job type
 * is snake_case (e.g. 'cef_syslog_forward_batch'). Conversion is a
 * single helper rather than a lookup table — adding a plugin requires
 * one catalog entry + one processor and no edit here.
 */
function jobTypeForPlugin(pluginKey: string): string {
  return pluginKey.replace(/-/g, '_') + '_forward_batch';
}

interface DestinationRow {
  id: string;
  plugin_key: string;
  filters: unknown;
}

export async function enqueueForwardJobs(
  agencyId: string,
  batch: AuditEvent[],
): Promise<void> {
  if (!agencyId || batch.length === 0) return;

  const { prisma, enqueueJob, logger } = getRuntime();
  if (!prisma) {
    logger?.warn?.('[forward-dispatch] runtime.prisma not registered; skipping');
    return;
  }
  if (!enqueueJob) {
    // Host doesn't expose a queue (e.g. tests). Silently skip.
    return;
  }

  const destinations = await prisma.audit_destinations.findMany({
    where: { agency_id: agencyId, enabled: true },
    select: { id: true, plugin_key: true, filters: true },
  }) as DestinationRow[];

  if (destinations.length === 0) return;

  for (const dest of destinations) {
    const filters = (dest.filters ?? {
      sources: ['*'],
      minSeverity: 'info',
      excludePatterns: [],
    }) as AuditDestinationFilters;

    const passing = batch.filter((e) => matchesFilters(e, filters));
    if (passing.length === 0) continue;

    await enqueueJob(jobTypeForPlugin(dest.plugin_key), {
      tenantId: agencyId,        // required by tenant-scoped enqueue middleware
      destinationId: dest.id,
      agencyId,
      pluginKey: dest.plugin_key,
      events: passing,
    });
  }
}
