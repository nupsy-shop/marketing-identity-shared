/**
 * Client onboarding kit — applier (issue #62)
 *
 * Step machine:
 *   attach_platforms → install_templates → create_team → provision_team → notify
 *
 * Shared between the web app (HTTP route enqueues a Bull job) and the Bull
 * worker (`apply_onboarding_kit_for_client` processor in
 * marketing-identity-bull). Prisma/logger/enqueue access goes through
 * `getRuntime()` so each host can wire its own.
 *
 * Public entrypoints:
 *   - `runStepMachine()` — pure transition helper, testable in isolation.
 *   - `applyKit()` — orchestrates a full run (used by the worker).
 *
 * Invariants:
 *   - Client row is created BEFORE this runs. Never rolled back here.
 *   - Per-team-member grants rely on plugin.grantAccess() idempotency.
 *   - Welcome emails fire ONCE per member, ONLY for members with ≥ 1
 *     successful grant. `client.onboarded` fires whenever the client row
 *     + any client_role_assignments row exists.
 */

import { getRuntime } from '../runtime.js';
import { publishAuditEvent } from '../audit/publisher.js';
import { dispatchNotification } from '../notifications/dispatch.js';
import * as kitCrud from './crud.js';
import {
  RUN_STEP_ORDER,
  type RunStep,
  type RunStepName,
  type RunStepStatus,
  type RunSummary,
  type TeamMemberInput,
} from './types.js';

// ─── Pure step-machine helper (unit-tested) ─────────────────────────────────

export interface StepTransitionInput {
  summary: RunSummary;
  stepName: RunStepName;
  status: RunStepStatus;
  error?: string;
  outcomes?: RunStep['outcomes'];
}

/** Applies a step transition to a RunSummary — pure, no I/O. */
export function runStepMachine(input: StepTransitionInput): RunSummary {
  const { summary, stepName, status, error, outcomes } = input;
  const nowIso = new Date().toISOString();

  const steps: RunStep[] = RUN_STEP_ORDER.map((name) => {
    const existing = summary.steps.find((s) => s.name === name);
    if (name !== stepName) {
      return existing ?? { name, status: 'pending' };
    }
    const prev = existing ?? { name, status: 'pending' as RunStepStatus };
    const startedAt = status === 'running' ? nowIso : prev.startedAt;
    const completedAt =
      status === 'ok' || status === 'failed' ? nowIso : prev.completedAt;
    return {
      ...prev,
      status,
      startedAt,
      completedAt,
      error: error ?? prev.error,
      outcomes: outcomes ?? prev.outcomes,
    };
  });

  return { ...summary, steps };
}

export function emptyRunSummary(): RunSummary {
  return {
    steps: RUN_STEP_ORDER.map((name) => ({ name, status: 'pending' as RunStepStatus })),
    counts: { teamMembers: 0, provisioned: 0, failed: 0, welcomesSent: 0 },
  };
}

/** True once every step is either ok or failed and none is pending/running. */
export function isRunTerminal(summary: RunSummary) {
  return summary.steps.every((s) => s.status === 'ok' || s.status === 'failed');
}

// ─── Dependencies (injected for testability) ─────────────────────────────────

export interface ApplyKitDeps {
  /** Look up kit by (agencyId, kitKey). */
  getKit: (agencyId: string, kitKey: string) => Promise<{ id: string; platform_keys: string[]; role_template_keys: string[]; welcome_template: string | null } | null>;
  /** Verify the client has all of `platformKeys` connected. Returns missing keys. */
  verifyPlatforms: (agencyId: string, clientId: string, platformKeys: string[]) => Promise<string[]>;
  /** Install role templates onto the client. Returns count installed. */
  installTemplates: (agencyId: string, clientId: string, templateKeys: string[]) => Promise<number>;
  /** Create team-member rows (csv → users + client_role_assignments; directory → client_role_assignments only). */
  createTeam: (agencyId: string, clientId: string, members: TeamMemberInput[], actorId: string | null) => Promise<Array<{ email: string; appUserId: string | null; created: boolean; error?: string }>>;
  /** Enqueue a bulk_provision job per team member — inherits #61 parallelization. */
  enqueueMemberProvision: (agencyId: string, clientId: string, appUserId: string, email: string) => Promise<string | null>;
  /** Snapshot per-member provisioning outcomes from integration_identities. */
  readProvisionOutcomes: (agencyId: string, clientId: string, appUserIds: string[]) => Promise<Map<string, { succeededCount: number; failedCount: number }>>;
  /** Send one welcome notification for a team member. */
  sendWelcome: (agencyId: string, clientId: string, email: string, template?: string | null, override?: string) => Promise<void>;
  /** Emit an audit event. */
  emitAudit: (event: string, payload: Record<string, unknown>) => void;
}

export interface ApplyKitContext {
  agencyId: string;
  clientId: string;
  runId: string;
  kitKey: string;
  teamMembers: TeamMemberInput[];
  welcomeOverride?: string;
  actorId?: string | null;
}

export interface ApplyKitResult {
  status: 'ok' | 'failed';
  summary: RunSummary;
}

// ─── Real dep implementations (wired into the worker entrypoint) ─────────────

const realDeps: ApplyKitDeps = {
  async getKit(agencyId, kitKey) {
    const kit = await kitCrud.getKitByKey(agencyId, kitKey);
    return kit as ApplyKitDeps['getKit'] extends (...a: unknown[]) => Promise<infer R> ? R : never;
  },

  async verifyPlatforms(agencyId, _clientId, platformKeys) {
    if (platformKeys.length === 0) return [];
    const { prisma } = getRuntime();
    // agency_platforms joins to catalog_platforms via `slug` (plugin key).
    const connected = await prisma.agency_platforms.findMany({
      where: {
        agency_id: agencyId,
        catalog_platforms: { is: { slug: { in: platformKeys } } },
      },
      include: { catalog_platforms: { select: { slug: true } } },
    });
    const have = new Set(
      connected.map((p: { catalog_platforms?: { slug?: string } }) => p.catalog_platforms?.slug).filter(Boolean) as string[],
    );
    return platformKeys.filter((k) => !have.has(k));
  },

  async installTemplates(agencyId, _clientId, templateKeys) {
    // Role templates live in agency_settings.role_templates JSONB — they are
    // "installed on" a client implicitly via client_role_assignments at
    // provisioning time. No-op here beyond verifying the template keys exist.
    if (templateKeys.length === 0) return 0;
    const { prisma } = getRuntime();
    const settings = await prisma.agency_settings.findFirst({
      where: { agency_id: agencyId },
      select: { role_templates: true } as never,
    }) as { role_templates?: unknown } | null;
    const rt = (settings?.role_templates ?? []) as Array<{ key?: string; id?: string }>;
    const known = new Set(rt.map((t) => t.key || t.id).filter(Boolean) as string[]);
    return templateKeys.filter((k) => known.has(k)).length;
  },

  async createTeam(agencyId, clientId, members, actorId) {
    const { prisma } = getRuntime();
    const outcomes: Array<{ email: string; appUserId: string | null; created: boolean; error?: string }> = [];
    for (const m of members) {
      try {
        let appUserId: string | null = null;
        const existing = await prisma.users.findFirst({
          where: { agency_id: agencyId, email: m.email.toLowerCase() },
          select: { id: true },
        });
        if (existing) {
          appUserId = existing.id;
        } else if (m.source === 'csv') {
          // Create a minimal invite row — mirrors processTeamMembers (bulk-import:369).
          // We intentionally defer the heavy-lift CSV parsing to
          // processTemplateAssignments for the template-side; here we just
          // ensure the user row exists for client_role_assignments.
          const created = await prisma.users.create({
            data: {
              email: m.email.toLowerCase(),
              displayName: [m.firstName, m.lastName].filter(Boolean).join(' ') || m.email.split('@')[0],
              app_role: m.userType || 'client_operator',
              agency_id: agencyId,
              source_id: agencyId,
              is_active: true,
            } as never, // users table shape varies; kept intentionally loose
          }).catch(() => null);
          appUserId = created?.id ?? null;
        } else {
          // 'directory' path expects user to exist — record and skip.
          outcomes.push({ email: m.email, appUserId: null, created: false, error: 'directory user not found' });
          continue;
        }

        if (!appUserId) {
          outcomes.push({ email: m.email, appUserId: null, created: false, error: 'user creation failed' });
          continue;
        }

        // Idempotent client_role_assignments upsert — `@@unique([client_id, app_user_id, role])`.
        await prisma.client_role_assignments.upsert({
          where: {
            client_id_app_user_id_role: {
              client_id: clientId,
              app_user_id: appUserId,
              role: 'client_operator',
            },
          } as never,
          update: {
            role_template_key: m.roleTemplateKey ?? null,
            is_active: true,
            updated_at: new Date(),
          },
          create: {
            agency_id: agencyId,
            client_id: clientId,
            app_user_id: appUserId,
            role: 'client_operator',
            role_template_key: m.roleTemplateKey ?? null,
            assigned_by: actorId ?? null,
          },
        }).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          outcomes.push({ email: m.email, appUserId, created: false, error: msg });
          return null;
        });

        outcomes.push({ email: m.email, appUserId, created: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        outcomes.push({ email: m.email, appUserId: null, created: false, error: msg });
      }
    }
    return outcomes;
  },

  async enqueueMemberProvision(agencyId, clientId, appUserId, email) {
    // Fans out via existing bulk_provision queue — inherits #61 parallelization.
    const { enqueueJob } = getRuntime();
    if (!enqueueJob) return null;
    return enqueueJob('bulk_provision', {
      tenantId: agencyId,
      clientId,
      appUserId,
      email,
      source: 'onboarding_kit',
    });
  },

  async readProvisionOutcomes(agencyId, clientId, appUserIds) {
    if (appUserIds.length === 0) return new Map();
    const { prisma } = getRuntime();
    const rows = await prisma.integration_identities.findMany({
      where: { agency_id: agencyId, client_id: clientId, app_user_id: { in: appUserIds } } as never,
      select: { app_user_id: true, provisioning_status: true } as never,
    }) as Array<{ app_user_id: string; provisioning_status: string }>;

    const out = new Map<string, { succeededCount: number; failedCount: number }>();
    for (const uid of appUserIds) out.set(uid, { succeededCount: 0, failedCount: 0 });
    for (const r of rows) {
      const cur = out.get(r.app_user_id) || { succeededCount: 0, failedCount: 0 };
      if (r.provisioning_status === 'PROVISIONED') cur.succeededCount += 1;
      else if (r.provisioning_status === 'ERROR') cur.failedCount += 1;
      out.set(r.app_user_id, cur);
    }
    return out;
  },

  async sendWelcome(agencyId, clientId, email, _template, _override) {
    await dispatchNotification(agencyId, 'client.onboarded', {
      client: clientId,
      actor: email,
    }).catch(() => {});
  },

  emitAudit(event, payload) {
    // Use the canonical publisher so events land in Elasticsearch (where
    // the audit-log UI and E2E `queryAuditEvents` both read from).
    // The legacy `addAuditLog` writes only to the Postgres `audit_logs`
    // table and bypasses ES — see #673.
    const actorEmail = (payload.actor as string | undefined) || 'system';
    const agencyId = (payload.agencyId as string | undefined) ?? null;
    publishAuditEvent({
      eventType: event,
      severity: 'info',
      source: 'onboarding-kits',
      actor: { id: null, email: actorEmail, type: 'user' },
      agency: { id: agencyId },
      context: payload,
    }).catch(() => {});
  },
};

// ─── Orchestrator ────────────────────────────────────────────────────────────

/**
 * Apply a kit to a client. The client row is assumed to exist already.
 * Returns the final summary regardless of per-step outcome.
 *
 * Overall `status` is 'failed' only if a halting step (attach_platforms,
 * install_templates) fails. `create_team` / `provision_team` partial failures
 * keep status 'ok' and record per-member failures — this matches the
 * promise: the client persists, operators retry per row.
 */
export async function applyKit(
  ctx: ApplyKitContext,
  deps: ApplyKitDeps = realDeps,
): Promise<ApplyKitResult> {
  const { prisma, logger } = getRuntime();
  let summary = emptyRunSummary();
  summary.counts = {
    teamMembers: ctx.teamMembers.length,
    provisioned: 0,
    failed: 0,
    welcomesSent: 0,
  };

  const auditBase = {
    agencyId: ctx.agencyId,
    clientId: ctx.clientId,
    kitKey: ctx.kitKey,
    teamMemberCount: ctx.teamMembers.length,
  };

  deps.emitAudit('client.onboarding_kit.applied', auditBase);

  const kit = await deps.getKit(ctx.agencyId, ctx.kitKey);
  if (!kit) {
    summary = runStepMachine({ summary, stepName: 'attach_platforms', status: 'failed', error: `kit "${ctx.kitKey}" not found for agency ${ctx.agencyId}` });
    deps.emitAudit('client.onboarding_kit.step.failed', { ...auditBase, stepName: 'attach_platforms', error: 'kit not found' });
    return { status: 'failed', summary };
  }

  // ── Step 1: attach_platforms (halting if missing) ────────────────────────
  summary = runStepMachine({ summary, stepName: 'attach_platforms', status: 'running' });
  try {
    const missing = await deps.verifyPlatforms(ctx.agencyId, ctx.clientId, kit.platform_keys);
    if (missing.length > 0) {
      const err = `missing platforms: ${missing.join(', ')}`;
      summary = runStepMachine({ summary, stepName: 'attach_platforms', status: 'failed', error: err });
      deps.emitAudit('client.onboarding_kit.step.failed', { ...auditBase, stepName: 'attach_platforms', error: err });
      return { status: 'failed', summary };
    }
    summary = runStepMachine({ summary, stepName: 'attach_platforms', status: 'ok' });
    deps.emitAudit('client.onboarding_kit.step.ok', { ...auditBase, stepName: 'attach_platforms' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    summary = runStepMachine({ summary, stepName: 'attach_platforms', status: 'failed', error: msg });
    deps.emitAudit('client.onboarding_kit.step.failed', { ...auditBase, stepName: 'attach_platforms', error: msg });
    return { status: 'failed', summary };
  }

  // ── Step 2: install_templates ────────────────────────────────────────────
  summary = runStepMachine({ summary, stepName: 'install_templates', status: 'running' });
  try {
    await deps.installTemplates(ctx.agencyId, ctx.clientId, kit.role_template_keys);
    summary = runStepMachine({ summary, stepName: 'install_templates', status: 'ok' });
    deps.emitAudit('client.onboarding_kit.step.ok', { ...auditBase, stepName: 'install_templates' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    summary = runStepMachine({ summary, stepName: 'install_templates', status: 'failed', error: msg });
    deps.emitAudit('client.onboarding_kit.step.failed', { ...auditBase, stepName: 'install_templates', error: msg });
    return { status: 'failed', summary };
  }

  // ── Step 3: create_team ──────────────────────────────────────────────────
  summary = runStepMachine({ summary, stepName: 'create_team', status: 'running' });
  const teamOutcomes = await deps.createTeam(ctx.agencyId, ctx.clientId, ctx.teamMembers, ctx.actorId ?? null);
  const teamStep: RunStep['outcomes'] = teamOutcomes.map((o) => ({
    email: o.email,
    status: o.created ? 'created' : 'failed',
    error: o.error,
  }));
  summary = runStepMachine({ summary, stepName: 'create_team', status: 'ok', outcomes: teamStep });
  deps.emitAudit('client.onboarding_kit.step.ok', { ...auditBase, stepName: 'create_team', created: teamOutcomes.filter((o) => o.created).length });

  // ── Step 4: provision_team ───────────────────────────────────────────────
  summary = runStepMachine({ summary, stepName: 'provision_team', status: 'running' });
  const provisionableUserIds: string[] = [];
  for (const o of teamOutcomes) {
    if (o.created && o.appUserId) {
      const jobId = await deps.enqueueMemberProvision(ctx.agencyId, ctx.clientId, o.appUserId, o.email);
      if (jobId) provisionableUserIds.push(o.appUserId);
    }
  }
  summary = runStepMachine({ summary, stepName: 'provision_team', status: 'ok' });
  deps.emitAudit('client.onboarding_kit.step.ok', { ...auditBase, stepName: 'provision_team', enqueued: provisionableUserIds.length });

  // Snapshot per-member outcomes (best-effort — children may still be in-flight).
  const outcomes = await deps.readProvisionOutcomes(ctx.agencyId, ctx.clientId, provisionableUserIds);
  let provisioned = 0;
  let failed = 0;
  const membersWithSuccess: Array<{ email: string; appUserId: string }> = [];
  for (const o of teamOutcomes) {
    if (!o.appUserId) { failed += 1; continue; }
    const counts = outcomes.get(o.appUserId);
    if (counts && counts.succeededCount > 0) {
      provisioned += 1;
      membersWithSuccess.push({ email: o.email, appUserId: o.appUserId });
    } else if (counts && counts.failedCount > 0) {
      failed += 1;
    }
  }

  // ── Step 5: notify (welcome emails + client.onboarded) ───────────────────
  summary = runStepMachine({ summary, stepName: 'notify', status: 'running' });
  let welcomesSent = 0;
  for (const m of membersWithSuccess) {
    try {
      await deps.sendWelcome(ctx.agencyId, ctx.clientId, m.email, kit.welcome_template, ctx.welcomeOverride);
      welcomesSent += 1;
    } catch (err: unknown) {
      logger.warn('[applyKit] welcome send failed:', { err: err instanceof Error ? err.message : String(err) });
    }
  }

  summary = runStepMachine({ summary, stepName: 'notify', status: 'ok' });
  summary.counts = {
    teamMembers: ctx.teamMembers.length,
    provisioned,
    failed,
    welcomesSent,
  };

  // `client.onboarded` fires whenever client + any role assignment exists —
  // independent of welcome fan-out. Check via DB.
  const anyAssignment = await prisma.client_role_assignments.findFirst({
    where: { agency_id: ctx.agencyId, client_id: ctx.clientId },
    select: { id: true },
  });
  if (anyAssignment) {
    deps.emitAudit('client.onboarded', {
      ...auditBase,
      provisionedCount: provisioned,
      failedCount: failed,
      welcomeCount: welcomesSent,
    });
    dispatchNotification(ctx.agencyId, 'client.onboarded', {
      client: ctx.clientId,
      kitKey: ctx.kitKey,
      provisionedCount: provisioned,
      failedCount: failed,
      welcomeCount: welcomesSent,
    }).catch(() => {});
  }

  deps.emitAudit('client.onboarding_kit.step.ok', { ...auditBase, stepName: 'notify', welcomeCount: welcomesSent });

  return { status: 'ok', summary };
}
