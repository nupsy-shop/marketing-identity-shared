/**
 * Principal-level drift detector (issue #90).
 *
 * Walks every identity source for an agency and produces per-principal
 * drift signals persisted in `drift_findings`. Emission of
 * `drift.detected` events is deduped by state transitions:
 *
 *   - prior row missing + current unhealthy → INSERT, emit (new_unhealthy)
 *   - prior state === current state         → UPDATE last_seen_at only
 *                                              (no emission)
 *   - prior unhealthy → healthy             → UPDATE, emit (resolved)
 *   - prior healthy   → unhealthy           → UPDATE, emit (regressed)
 *
 * Event emission calls into the remediation pipeline (PR-B unified path)
 * so the autonomy matrix is enforced centrally and the workflow engine
 * drives the single execution surface.
 *
 * Coverage (per autonomy matrix):
 *   - Local Directory + identity + drift_type='keycloak_missing'  → auto (#90)
 *   - GW / Entra     + synthetic_identity + 'provider_missing'    → auto (#89)
 *   - GW / Entra     + identity + 'identity_missing'              → flag-and-notify
 *   - GW / Entra     + identity + 'identity_inactive'             → flag-and-notify
 *
 * GW / Entra users are also visited but the orchestrator short-circuits
 * them with reason `jml_owns_users`.
 */

import { getRuntime } from '../../runtime.js';
import { evaluateAndRemediate } from '../../governance/remediation-engine.js';
import { evaluateSourceGates, type GateReason } from './principal-detector-gates.js';
import { publishAuditEvent } from '../../audit/publisher.js';
import { getDriftAdapter } from '../../../plugins/identity/drift-adapter-registry.js';
import type { ConnectionConfigShape } from './types.js';

export type DriftFindingState = 'healthy' | 'unhealthy';

export interface PrincipalSignal {
  sourcePluginKey: string;
  principalType: 'identity' | 'user' | 'synthetic_identity' | 'orphan';
  principalId: string;
  driftType: string;
  currentState: DriftFindingState;
}

export interface DetectorEmission {
  transition: 'new_unhealthy' | 'regressed' | 'resolved';
  sourcePluginKey: string;
  principalType: string;
  principalId: string;
  driftType: string;
}

export interface DetectorResult {
  scanned: number;
  emissions: DetectorEmission[];
  skipped: Partial<Record<GateReason, number>>;
}

interface IdentitySourceRow {
  plugin_key: string;
  provisioning_enabled: boolean | null;
  connection_state: string | null;
  connection_config: Record<string, unknown> | null;
}

/**
 * Process a batch of principal signals: upsert `drift_findings` rows,
 * return the subset that crossed a state boundary (dedup).
 *
 * Pure over Prisma — no event publishing side-effects here. The caller
 * decides whether to forward emissions to the remediation pipeline.
 */
export async function upsertAndDedupe(
  agencyId: string,
  signals: PrincipalSignal[],
): Promise<DetectorEmission[]> {
  const { prisma } = getRuntime();
  const now = new Date();
  const emissions: DetectorEmission[] = [];

  for (const signal of signals) {
    const prior = await prisma.drift_findings.findFirst({
      where: {
        agency_id: agencyId,
        source_plugin_key: signal.sourcePluginKey,
        principal_id: signal.principalId,
        drift_type: signal.driftType,
      },
    });

    if (!prior) {
      if (signal.currentState === 'unhealthy') {
        await prisma.drift_findings.create({
          data: {
            agency_id: agencyId,
            source_plugin_key: signal.sourcePluginKey,
            principal_type: signal.principalType,
            principal_id: signal.principalId,
            drift_type: signal.driftType,
            state: 'unhealthy',
            first_detected_at: now,
            last_seen_at: now,
            last_transition_at: now,
            resolved_at: null,
          },
        });
        emissions.push({
          transition: 'new_unhealthy',
          sourcePluginKey: signal.sourcePluginKey,
          principalType: signal.principalType,
          principalId: signal.principalId,
          driftType: signal.driftType,
        });
      }
      // prior missing + current healthy: nothing to record
      continue;
    }

    // PR 5c — skip dismissed findings: they stay visible with a "Dismissed"
    // badge but should NOT be re-flagged on future scans.  Update last_seen_at
    // so the row doesn't look stale but do NOT emit a transition event.
    const priorRecord = prior as typeof prior & { dismissed_at?: Date | null };
    if (priorRecord.dismissed_at != null) {
      await prisma.drift_findings.update({
        where: { id: prior.id },
        data: { last_seen_at: now, updated_at: now },
      });
      continue;
    }

    if (prior.state === signal.currentState) {
      // Dedup: same state — refresh liveness only, no emission.
      await prisma.drift_findings.update({
        where: { id: prior.id },
        data: { last_seen_at: now, updated_at: now },
      });
      continue;
    }

    // State transition.
    const transition: DetectorEmission['transition'] =
      prior.state === 'unhealthy' ? 'resolved' : 'regressed';
    await prisma.drift_findings.update({
      where: { id: prior.id },
      data: {
        state: signal.currentState,
        last_seen_at: now,
        last_transition_at: now,
        resolved_at: signal.currentState === 'healthy' ? now : null,
        updated_at: now,
      },
    });
    emissions.push({
      transition,
      sourcePluginKey: signal.sourcePluginKey,
      principalType: signal.principalType,
      principalId: signal.principalId,
      driftType: signal.driftType,
    });
  }

  return emissions;
}

/**
 * Collect `keycloak_missing` drift signals for Local Directory users of
 * an agency. A local user is unhealthy when `keycloak_user_id` is unset;
 * healthy when set. Other IdPs are covered by JML (GW/Entra user) or
 * PR-E (synthetic identities).
 */
export async function collectLocalDirectorySignals(
  agencyId: string,
): Promise<PrincipalSignal[]> {
  const { prisma } = getRuntime();
  const rows = await prisma.local_directory_users.findMany({
    where: { agency_id: agencyId, is_active: true },
    select: { id: true, keycloak_user_id: true },
  });
  return rows.map((r: { id: string; keycloak_user_id: string | null }) => ({
    sourcePluginKey: 'local-directory',
    principalType: 'identity' as const,
    principalId: r.id,
    driftType: 'keycloak_missing',
    currentState: r.keycloak_user_id ? ('healthy' as const) : ('unhealthy' as const),
  }));
}

/**
 * Collect `identity_missing` drift signals for HUMAN_INTERACTIVE identities
 * on a given provider. An HI identity is unhealthy when its `identifier`
 * (email) is absent from the cached directory table for that provider.
 *
 * Edge-case: if the directory cache is entirely empty for all sources of
 * that plugin (sync has not run yet / new source), NO signals are emitted —
 * not even healthy ones — to avoid flooding drift_findings with false
 * positives during the initial sync window.
 *
 * Multiple sources of the same plugin are aggregated: the union of all cached
 * emails across all sources is used. A non-empty cache in ANY source disables
 * the empty-cache guard so we don't skip detection just because one of two
 * sources is freshly added.
 */
export async function collectMissingHumanIdentitySignals(
  agencyId: string,
  providerKey: 'google-workspace' | 'entra-id',
): Promise<PrincipalSignal[]> {
  const { prisma } = getRuntime();

  // 1. HI identities targeting this provider for this agency.
  const identities = await prisma.integration_identities.findMany({
    where: {
      agency_id: agencyId,
      isActive: true,
      type: 'HUMAN_INTERACTIVE',
      provisioning_targets: { has: providerKey },
    },
    select: { id: true, identifier: true },
  });

  if (identities.length === 0) return [];

  // 2. Identity sources for this agency + plugin.
  const sources = await prisma.identity_sources.findMany({
    where: { agency_id: agencyId, plugin_key: providerKey },
    select: { id: true },
  });

  if (sources.length === 0) return [];

  const sourceIds = sources.map((s: { id: string }) => s.id);

  // 3. Fetch cached directory emails for these sources.
  type EmailRow = { email: string };
  let cachedRows: EmailRow[] = [];
  if (providerKey === 'google-workspace') {
    cachedRows = await prisma.gws_directory_users.findMany({
      where: { source_id: { in: sourceIds } },
      select: { email: true },
    });
  } else {
    // Entra: filter is_present_in_idp=true so soft-deleted rows (removed from
    // Graph but still cached) are excluded from the "present" set.
    // GWS does not have this column — leave the GWS branch as-is.
    cachedRows = await prisma.entra_directory_users.findMany({
      where: { source_id: { in: sourceIds }, is_present_in_idp: true },
      select: { email: true },
    });
  }

  // 4. Empty-cache guard: if no rows exist in ANY source, skip entirely.
  //    We cannot distinguish "user is missing" from "sync has not run".
  if (cachedRows.length === 0) return [];

  const cachedEmails = new Set(cachedRows.map((r) => r.email.toLowerCase()));

  // 5. Emit one signal per HI identity.
  return identities.map((identity: { id: string; identifier: string }) => ({
    sourcePluginKey: providerKey,
    principalType: 'identity' as const,
    principalId: identity.id,
    driftType: 'identity_missing',
    currentState: cachedEmails.has(identity.identifier.toLowerCase())
      ? ('healthy' as const)
      : ('unhealthy' as const),
  }));
}

/**
 * Collect `identity_inactive` drift signals for HUMAN_INTERACTIVE identities
 * on a given provider. An HI identity is unhealthy when its `identifier`
 * (email) is present in the cached directory table for that provider AND the
 * corresponding row has `is_active = false`.
 *
 * If the identity's email is absent from the cache entirely, that is
 * `identity_missing` territory — handled by `collectMissingHumanIdentitySignals`.
 * This collector emits nothing for that case.
 *
 * For Entra: only rows with `is_present_in_idp = true` are considered (rows
 * with `is_present_in_idp = false` are the missing domain — excluded here).
 *
 * Any-active-wins semantics across multiple sources: if ANY row for the email
 * is active, the identity is healthy.
 *
 * Empty-cache guard: same as `collectMissingHumanIdentitySignals` — if the
 * union of all source caches is empty, no signals are emitted.
 */
export async function collectInactiveHumanIdentitySignals(
  agencyId: string,
  providerKey: 'google-workspace' | 'entra-id',
): Promise<PrincipalSignal[]> {
  const { prisma } = getRuntime();

  // 1. HI identities targeting this provider for this agency.
  const identities = await prisma.integration_identities.findMany({
    where: {
      agency_id: agencyId,
      isActive: true,
      type: 'HUMAN_INTERACTIVE',
      provisioning_targets: { has: providerKey },
    },
    select: { id: true, identifier: true },
  });

  if (identities.length === 0) return [];

  // 2. Identity sources for this agency + plugin.
  const sources = await prisma.identity_sources.findMany({
    where: { agency_id: agencyId, plugin_key: providerKey },
    select: { id: true },
  });

  if (sources.length === 0) return [];

  const sourceIds = sources.map((s: { id: string }) => s.id);

  // 3. Fetch cached directory rows with is_active for these sources.
  type Row = { email: string; is_active: boolean };
  let rows: Row[] = [];
  if (providerKey === 'google-workspace') {
    rows = await prisma.gws_directory_users.findMany({
      where: { source_id: { in: sourceIds } },
      select: { email: true, is_active: true },
    });
  } else {
    // Entra: exclude is_present_in_idp=false (those are identity_missing domain).
    rows = await prisma.entra_directory_users.findMany({
      where: { source_id: { in: sourceIds }, is_present_in_idp: true },
      select: { email: true, is_active: true },
    });
  }

  // 4. Empty-cache guard: initial sync may not have run yet.
  if (rows.length === 0) return [];

  // 5. Build email → is_active map with any-active-wins semantics:
  //    If ANY row for an email is active, the identity is active.
  //    Inactive only when every matching row is inactive.
  const activeByEmail = new Map<string, boolean>();
  for (const r of rows) {
    const email = r.email.toLowerCase();
    if (activeByEmail.get(email) === true) continue; // already known active
    activeByEmail.set(email, r.is_active);
  }

  // 6. Emit one signal per HI identity that appears in the cache.
  //    Identities absent from the cache are identity_missing territory — skip.
  const signals: PrincipalSignal[] = [];
  for (const identity of identities as Array<{ id: string; identifier: string }>) {
    const email = identity.identifier.toLowerCase();
    if (!activeByEmail.has(email)) continue; // not in cache → missing's job
    const isActive = activeByEmail.get(email)!;
    signals.push({
      sourcePluginKey: providerKey,
      principalType: 'identity' as const,
      principalId: identity.id,
      driftType: 'identity_inactive',
      currentState: isActive ? ('healthy' as const) : ('unhealthy' as const),
    });
  }
  return signals;
}

/**
 * Collect `provider_missing` drift signals for synthetic identities (service
 * accounts, shared inboxes/mailboxes, API keys, OAuth clients) on a given
 * provider. A synthetic identity is unhealthy when its per-provider status
 * in `provisioning_providers_status[<providerKey>]` is anything other than
 * `PROVISIONED`; healthy when it is `PROVISIONED`. Issue #89.
 */
export async function collectSyntheticIdentitySignals(
  agencyId: string,
  providerKey: 'google-workspace' | 'entra-id',
): Promise<PrincipalSignal[]> {
  const { prisma } = getRuntime();
  const rows = await prisma.integration_identities.findMany({
    where: {
      agency_id: agencyId,
      isActive: true,
      type: {
        in: ['SERVICE_ACCOUNT', 'SHARED_CREDENTIAL', 'API_KEY', 'OAUTH_CLIENT'],
      },
      provisioning_targets: { has: providerKey },
    },
    select: { id: true, provisioning_providers_status: true },
  });
  return rows.map((r: { id: string; provisioning_providers_status: Record<string, { status?: string }> | null }) => {
    const status = (r.provisioning_providers_status || {}) as Record<string, { status?: string }>;
    const ok = status[providerKey]?.status === 'PROVISIONED';
    return {
      sourcePluginKey: providerKey,
      principalType: 'synthetic_identity' as const,
      principalId: r.id,
      driftType: 'provider_missing',
      currentState: (ok ? 'healthy' : 'unhealthy') as 'healthy' | 'unhealthy',
    };
  });
}

/**
 * Collect `orphan_in_federation` drift signals for provider users in the
 * federated space (GWS managed OU / Entra federated domain) that have no
 * matching `integration_identities` record for this agency.
 *
 * Design decision: Option B — flag-and-notify. No auto-create (would
 * legitimize unauthorized access), no auto-revoke (would disrupt legitimate
 * vendor/service accounts). Admin must disposition each orphan manually.
 *
 * Skips sources where `describeFederatedSpace(cfg).configured === false` to
 * avoid false positives on sources that don't define a federated space.
 *
 * `principalType` is `'orphan'` — these have no integration_identities row.
 * `principalId` is the email (lowercased) — natural key for orphans.
 */
export async function collectFederationOrphanSignals(
  agencyId: string,
  providerKey: 'google-workspace' | 'entra-id',
): Promise<PrincipalSignal[]> {
  const { prisma } = getRuntime();

  const sources = await prisma.identity_sources.findMany({
    where: { agency_id: agencyId, plugin_key: providerKey },
    select: { id: true, connection_config: true },
  });
  if (sources.length === 0) return [];

  // Build exclude set: every existing integration_identities.identifier for the agency.
  type IdentifierRow = { identifier: string };
  const existing: IdentifierRow[] = await prisma.integration_identities.findMany({
    where: { agency_id: agencyId },
    select: { identifier: true },
  });
  const excludeEmails = new Set<string>(
    existing.map((i) => i.identifier.toLowerCase()),
  );

  const adapter = getDriftAdapter(providerKey);

  const signals: PrincipalSignal[] = [];
  for (const src of sources) {
    const cfg = (src.connection_config ?? {}) as ConnectionConfigShape;

    // Gate: skip if no federated space configured for this source.
    if (!adapter.describeFederatedSpace(cfg).configured) continue;

    const orphans = await adapter.findFederationOrphans(src.id, agencyId, cfg, excludeEmails);
    for (const o of orphans) {
      signals.push({
        sourcePluginKey: providerKey,
        principalType: 'orphan' as const,
        principalId: o.email.toLowerCase(),
        driftType: 'orphan_in_federation',
        currentState: 'unhealthy' as const,
      });
    }
  }
  return signals;
}

/**
 * Run principal drift detection for one agency. Forwards each emission
 * to the remediation pipeline — the orchestrator enforces the autonomy
 * matrix, rate limit + circuit breaker, then dispatches.
 *
 * After upsertAndDedupe, source settings are batch-loaded and each emission
 * is evaluated against source-level gates (provisioning_enabled,
 * connection_state, autoProvisionUsers). Gated emissions are skipped
 * (no workflow dispatch) and audited as 'remediation.skipped'.
 */
export async function detectPrincipalDrift(
  agencyId: string,
): Promise<DetectorResult> {
  const { prisma, logger } = getRuntime();

  const signals = [
    ...(await collectLocalDirectorySignals(agencyId)),
    ...(await collectSyntheticIdentitySignals(agencyId, 'google-workspace')),
    ...(await collectSyntheticIdentitySignals(agencyId, 'entra-id')),
    ...(await collectMissingHumanIdentitySignals(agencyId, 'google-workspace')),
    ...(await collectMissingHumanIdentitySignals(agencyId, 'entra-id')),
    ...(await collectInactiveHumanIdentitySignals(agencyId, 'google-workspace')),
    ...(await collectInactiveHumanIdentitySignals(agencyId, 'entra-id')),
    ...(await collectFederationOrphanSignals(agencyId, 'google-workspace')),
    ...(await collectFederationOrphanSignals(agencyId, 'entra-id')),
  ];
  const emissions = await upsertAndDedupe(agencyId, signals);

  // Batch-load source settings for all plugin keys appearing in emissions.
  const pluginKeys = Array.from(new Set(emissions.map((e) => e.sourcePluginKey)));
  const sources = (await prisma.identity_sources.findMany({
    where: { agency_id: agencyId, plugin_key: { in: pluginKeys } },
    select: {
      plugin_key: true,
      provisioning_enabled: true,
      connection_state: true,
      connection_config: true,
    },
  })) as IdentitySourceRow[];
  const sourceByPlugin = new Map<string, IdentitySourceRow>(
    sources.map((s) => [s.plugin_key, s]),
  );

  const skipped: Partial<Record<GateReason, number>> = {};

  for (const e of emissions) {
    const src = sourceByPlugin.get(e.sourcePluginKey);
    if (!src) continue;

    const cfg = (src.connection_config as Record<string, unknown> | null) ?? {};
    const gate = evaluateSourceGates(
      {
        provisioningEnabled: src.provisioning_enabled ?? false,
        connectionState: src.connection_state ?? 'disconnected',
        autoProvisionUsers: cfg.autoProvisionUsers as boolean | undefined,
      },
      e.driftType,
    );

    if (!gate.allow) {
      skipped[gate.reason] = (skipped[gate.reason] ?? 0) + 1;
      await publishAuditEvent({
        eventType: 'remediation.skipped',
        action: 'skipped',
        actor: { id: 'system' },
        agency_id: agencyId,
        context: {
          reason: gate.reason,
          sourcePluginKey: e.sourcePluginKey,
          principalType: e.principalType,
          principalId: e.principalId,
          driftType: e.driftType,
          transition: e.transition,
        },
      }).catch(() => {});
      continue;
    }

    try {
      await evaluateAndRemediate(agencyId, 'drift.detected', {
        sourcePluginKey: e.sourcePluginKey,
        principalType: e.principalType,
        principalId: e.principalId,
        driftType: e.driftType,
        transition: e.transition,
      });
    } catch (err) {
      logger.error(
        '[PrincipalDriftDetector] evaluateAndRemediate failed',
        { message: (err as Error).message },
      );
    }
  }

  return { scanned: signals.length, emissions, skipped };
}
