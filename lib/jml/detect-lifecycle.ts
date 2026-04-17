/**
 * JML Detect Lifecycle — Shared Library
 *
 * Computes principal-lifecycle events (joiner / leaver / suspend / unsuspend)
 * for a single identity source. The drift adapter is the only source of
 * truth for provider-side state (directory users, scope, federation
 * orphans); this module joins the adapter's view with the local `users`
 * table to classify lifecycle events. Nothing here duplicates logic the
 * adapter already owns.
 *
 * Classification (in-scope only):
 *
 *   joiner       — directory user in scope, no matching local user
 *   leaver       — local user in scope, no matching directory user
 *   suspended    — directory user inactive, local user still active
 *   unsuspended  — directory user active, local user inactive
 *
 * Federation orphans surfaced by the adapter are merged into `leavers` so
 * the downstream policy engine applies reconciliation policy uniformly.
 *
 * Mover events (group-membership adds/removals, attribute diffs) are
 * captured by the sync processor (only it sees before/after) and passed
 * through this job to jml_process_lifecycle.
 */

import { getRuntime } from '../runtime.js';
import { getDriftAdapter } from '../../plugins/identity/drift-adapter-registry.js';
import type {
  JmlScopeShape,
  ConnectionConfigShape,
} from '../identity/drift/types.js';
import type {
  LifecycleEvents,
  GroupChange,
  AttributeChange,
} from './lifecycle-processor.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface DetectLifecycleParams {
  tenantId: string;
  sourceId: string;
  pluginKey: string;
  groupChanges?: GroupChange[];
  attributeChanges?: AttributeChange[];
}

export type DetectLifecycleResult =
  | {
      status: 'completed';
      jobType: 'jml_detect_lifecycle';
      events: LifecycleEvents;
      counts: {
        joiners: number;
        leavers: number;
        suspended: number;
        unsuspended: number;
        federationOrphans: number;
        groupChanges: number;
        attributeChanges: number;
      };
    }
  | {
      status: 'skipped';
      jobType: 'jml_detect_lifecycle';
      reason: string;
    };

// ─── Internal row shape ────────────────────────────────────────────────────

type LocalUserRow = {
  email: string;
  is_active: boolean | null;
};

// ─── Entry point ───────────────────────────────────────────────────────────

export async function detectLifecycle(
  params: DetectLifecycleParams,
): Promise<DetectLifecycleResult> {
  const { tenantId, sourceId, pluginKey, groupChanges, attributeChanges } = params;
  const { prisma, logger } = getRuntime();

  // 1. Load source
  const source = await prisma.identity_sources.findFirst({
    where: { id: sourceId, agency_id: tenantId },
    select: {
      id: true,
      plugin_key: true,
      connection_config: true,
      jml_scope: true,
    },
  });

  if (!source) {
    return {
      status: 'skipped',
      jobType: 'jml_detect_lifecycle',
      reason: 'identity source not found',
    };
  }

  // 2. JML is enabled iff jml_scope is configured
  if (source.jml_scope == null) {
    return {
      status: 'skipped',
      jobType: 'jml_detect_lifecycle',
      reason: 'jml not configured for this source',
    };
  }

  // 3. Resolve adapter
  let adapter;
  try {
    adapter = getDriftAdapter(pluginKey);
  } catch {
    return {
      status: 'skipped',
      jobType: 'jml_detect_lifecycle',
      reason: `no drift adapter for plugin ${pluginKey}`,
    };
  }

  const scope = source.jml_scope as JmlScopeShape;

  // 4. Provider-side state (adapter is the source of truth)
  const providerUsers = await adapter.findAllDirectoryUsers(sourceId, tenantId);
  const scopedEmails = await adapter.resolveJmlScopeEmails(
    sourceId,
    tenantId,
    scope,
  );
  const inScope = (emailLc: string): boolean =>
    scopedEmails === null ? true : scopedEmails.has(emailLc);

  // 5. Local users (agency-wide)
  const localUsers: LocalUserRow[] = await prisma.users.findMany({
    where: { agency_id: tenantId },
    select: { email: true, is_active: true },
  });
  const localByEmail = new Map<string, LocalUserRow>(
    localUsers.map((u) => [u.email.toLowerCase(), u]),
  );

  // 6. Bucket provider users in scope
  const joiners: string[] = [];
  const suspended: string[] = [];
  const unsuspended: string[] = [];
  const providerEmails = new Set<string>();

  for (const u of providerUsers) {
    const emailLc = u.email.toLowerCase();
    if (!inScope(emailLc)) continue;
    providerEmails.add(emailLc);

    const local = localByEmail.get(emailLc);
    if (!local) {
      // In scope + not locally known → joiner (only when provider says active)
      if (u.isActive) joiners.push(u.email);
      continue;
    }

    if (u.isActive && local.is_active === false) {
      unsuspended.push(u.email);
    } else if (!u.isActive && local.is_active !== false) {
      suspended.push(u.email);
    }
  }

  // 7. Leavers — local users in scope with no matching provider row
  const leavers: string[] = [];
  for (const local of localUsers) {
    const emailLc = local.email.toLowerCase();
    if (!inScope(emailLc)) continue;
    if (providerEmails.has(emailLc)) continue;
    if (local.is_active === false) continue;
    leavers.push(local.email);
  }

  // 8. Federation orphans — merged into leavers (case-insensitive dedup)
  const cfg = (source.connection_config ?? {}) as ConnectionConfigShape;
  const excludeEmails = new Set(
    localUsers.map((u) => u.email.toLowerCase()),
  );
  const orphans = await adapter.findFederationOrphans(
    sourceId,
    tenantId,
    cfg,
    excludeEmails,
  );
  const leaversLc = new Set(leavers.map((e) => e.toLowerCase()));
  for (const o of orphans) {
    const keyLc = o.email.toLowerCase();
    if (!leaversLc.has(keyLc)) {
      leavers.push(o.email);
      leaversLc.add(keyLc);
    }
  }

  const events: LifecycleEvents = {
    joiners: joiners.length > 0 ? joiners : undefined,
    leavers: leavers.length > 0 ? leavers : undefined,
    suspended: suspended.length > 0 ? suspended : undefined,
    unsuspended: unsuspended.length > 0 ? unsuspended : undefined,
    groupChanges: groupChanges && groupChanges.length > 0 ? groupChanges : undefined,
    attributeChanges:
      attributeChanges && attributeChanges.length > 0 ? attributeChanges : undefined,
  };

  logger.info('jml_detect_lifecycle: computed principal drift', {
    tenantId,
    sourceId,
    pluginKey,
    joiners: joiners.length,
    leavers: leavers.length,
    suspended: suspended.length,
    unsuspended: unsuspended.length,
    federationOrphans: orphans.length,
    groupChanges: groupChanges?.length ?? 0,
    attributeChanges: attributeChanges?.length ?? 0,
  });

  return {
    status: 'completed',
    jobType: 'jml_detect_lifecycle',
    events,
    counts: {
      joiners: joiners.length,
      leavers: leavers.length,
      suspended: suspended.length,
      unsuspended: unsuspended.length,
      federationOrphans: orphans.length,
      groupChanges: groupChanges?.length ?? 0,
      attributeChanges: attributeChanges?.length ?? 0,
    },
  };
}

// ─── Predicate ─────────────────────────────────────────────────────────────

export function hasEvents(events: LifecycleEvents): boolean {
  return (
    (events.joiners?.length ?? 0) > 0 ||
    (events.leavers?.length ?? 0) > 0 ||
    (events.suspended?.length ?? 0) > 0 ||
    (events.unsuspended?.length ?? 0) > 0 ||
    (events.groupChanges?.length ?? 0) > 0 ||
    (events.attributeChanges?.length ?? 0) > 0
  );
}
