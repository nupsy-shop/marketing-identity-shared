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
 *
 * GW / Entra users are also visited but the orchestrator short-circuits
 * them with reason `jml_owns_users`.
 */

import { getRuntime } from '../../runtime.js';
import { evaluateAndRemediate } from '../../governance/remediation-engine.js';
import { evaluateSourceGates, type GateReason } from './principal-detector-gates.js';
import { publishAuditEvent } from '../../audit/publisher.js';

export type DriftFindingState = 'healthy' | 'unhealthy';

export interface PrincipalSignal {
  sourcePluginKey: string;
  principalType: 'identity' | 'user' | 'synthetic_identity';
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
        connectionState: src.connection_state ?? 'connected',
        autoProvisionUsers: cfg.autoProvisionUsers as boolean | undefined,
      },
      e.driftType,
    );

    if (!gate.allow) {
      skipped[gate.reason] = (skipped[gate.reason] ?? 0) + 1;
      await publishAuditEvent({
        eventType: 'remediation.skipped',
        source: 'principal-detector',
        severity: 'info',
        agency: { id: agencyId },
        actor: { id: 'system', type: 'system' },
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
