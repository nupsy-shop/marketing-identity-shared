/**
 * JML Detect Lifecycle — Shared Library
 *
 * Compares the fresh directory mirror (just populated by a sync processor)
 * against `integration_identities` (updated by `jml_process_lifecycle` after
 * the last cycle) to produce principal-lifecycle events:
 *
 *   joiner       — new user in the directory with no matching identity
 *   leaver       — identity exists but the user is no longer in the directory
 *   suspended    — identity.isActive=true  but mirror.is_active=false
 *   unsuspended  — identity.isActive=false but mirror.is_active=true
 *
 * Plus federation orphans surfaced by the drift adapter (users living in the
 * federated space — GWS managed OU, Entra federated domain — that are not
 * tracked as identities). Orphans are merged into `leavers` so the downstream
 * policy engine can decide how to reconcile them.
 *
 * Group membership and attribute-change detection are intentionally out of
 * scope here — this module is strictly principal-lifecycle. Mover events
 * driven by attribute/group deltas live in `mover-detector.ts`.
 *
 * Called by the Bull worker's `jml_detect_lifecycle` processor. On completion
 * it enqueues `jml_process_lifecycle` with the computed batch; `jml_process_lifecycle`
 * owns scope filtering, guardrails, and action dispatch.
 */

import { getRuntime } from '../runtime.js';
import { getDriftAdapter } from '../../plugins/identity/drift-adapter-registry.js';
import type {
  JmlScopeShape,
  ConnectionConfigShape,
} from '../identity/drift/types.js';
import type { LifecycleEvents } from './lifecycle-processor.js';

// ─── Public types ──────────────────────────────────────────────────────────

export interface DetectLifecycleParams {
  tenantId: string;
  sourceId: string;
  pluginKey: string;
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
      };
    }
  | {
      status: 'skipped';
      jobType: 'jml_detect_lifecycle';
      reason: string;
    };

// ─── Internal row shapes ───────────────────────────────────────────────────

type IdentityRow = {
  id: string;
  identifier: string;   // lowercase email for IdP-synced users
  isActive: boolean;
};

type SourceRow = {
  id: string;
  plugin_key: string;
  connection_config: ConnectionConfigShape | null;
  jml_scope: JmlScopeShape;
};

// ─── Entry point ───────────────────────────────────────────────────────────

/**
 * Run principal-drift detection for a single identity source. Pure, no
 * enqueue. The caller (worker processor) is responsible for enqueueing
 * `jml_process_lifecycle` when status='completed' and any bucket is non-empty.
 */
export async function detectLifecycle(
  params: DetectLifecycleParams,
): Promise<DetectLifecycleResult> {
  const { tenantId, sourceId, pluginKey } = params;
  const { prisma, logger } = getRuntime();

  // 1. Load the identity source
  const source: SourceRow | null = await prisma.identity_sources.findFirst({
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

  // 2. JML enabled == jml_scope configured. The JML setup wizard gates scope
  //    configuration behind the jmlAutomation Lago entitlement, so a non-null
  //    jml_scope implies both entitlement and operator intent.
  if (source.jml_scope == null) {
    return {
      status: 'skipped',
      jobType: 'jml_detect_lifecycle',
      reason: 'jml not configured for this source',
    };
  }

  // 3. Resolve drift adapter for this plugin
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

  // 4. Snapshot: directory mirror (the "after" — fresh from the sync that
  //    just completed).
  const directoryUsers = await adapter.findAllDirectoryUsers(sourceId, tenantId);
  const activeDirEmails = new Set<string>();
  const inactiveDirEmails = new Set<string>();
  for (const u of directoryUsers) {
    const key = u.email.toLowerCase();
    if (u.isActive) activeDirEmails.add(key);
    else inactiveDirEmails.add(key);
  }

  // 5. Snapshot: identities (the "before" — reflects last JML-applied state
  //    since jml_process_lifecycle is what mutates integration_identities).
  const identities: IdentityRow[] = await prisma.integration_identities.findMany({
    where: { agency_id: tenantId, platform_key: pluginKey },
    select: { id: true, identifier: true, isActive: true },
  });
  const identityByEmail = new Map<string, IdentityRow>(
    identities.map((i) => [i.identifier.toLowerCase(), i]),
  );

  // 6. Diff
  const joiners: string[] = [];
  const leavers: string[] = [];
  const suspended: string[] = [];
  const unsuspended: string[] = [];

  // Joiners: active in directory, no matching identity
  for (const email of activeDirEmails) {
    if (!identityByEmail.has(email)) joiners.push(email);
  }

  // Leaver / suspend / unsuspend: walk identities and classify
  for (const [email, identity] of identityByEmail) {
    const inActiveDir = activeDirEmails.has(email);
    const inInactiveDir = inactiveDirEmails.has(email);

    if (!inActiveDir && !inInactiveDir) {
      // Gone from directory entirely
      if (identity.isActive) leavers.push(email);
      continue;
    }

    if (identity.isActive && inInactiveDir) {
      suspended.push(email);
      continue;
    }

    if (!identity.isActive && inActiveDir) {
      unsuspended.push(email);
      continue;
    }
    // else: identity and mirror agree → no change
  }

  // 7. Federation orphans — users in the federated space with no identity.
  //    Merged into leavers so the policy engine can apply the reconciliation
  //    policy uniformly.
  const cfg = source.connection_config ?? {};
  const excludeEmails = new Set(
    identities.map((i) => i.identifier.toLowerCase()),
  );
  const orphans = await adapter.findFederationOrphans(
    sourceId,
    tenantId,
    cfg,
    excludeEmails,
  );
  for (const o of orphans) {
    const key = o.email.toLowerCase();
    if (!leavers.includes(key)) leavers.push(key);
  }

  const events: LifecycleEvents = {
    joiners: joiners.length > 0 ? joiners : undefined,
    leavers: leavers.length > 0 ? leavers : undefined,
    suspended: suspended.length > 0 ? suspended : undefined,
    unsuspended: unsuspended.length > 0 ? unsuspended : undefined,
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
    },
  };
}

// ─── Predicate: does this result carry any event to process? ───────────────

export function hasEvents(events: LifecycleEvents): boolean {
  return (
    (events.joiners?.length ?? 0) > 0 ||
    (events.leavers?.length ?? 0) > 0 ||
    (events.suspended?.length ?? 0) > 0 ||
    (events.unsuspended?.length ?? 0) > 0
  );
}
