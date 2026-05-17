/**
 * Client onboarding kit — CRUD helpers (issue #62).
 *
 * Shared between the web app (HTTP routes / wizard) and the Bull worker
 * (apply_onboarding_kit_for_client processor). Prisma access goes through
 * `getRuntime()` because the two hosts register their own clients —
 * shared/ never imports `@/lib/db/prisma` directly.
 *
 * All reads/writes filter by agency_id. The wizard, apply endpoint, and
 * worker go through these helpers — no direct Prisma calls from routes.
 */

import { Prisma } from '@prisma/client';
import { getRuntime } from '../runtime.js';
import type { RunSummary } from './types.js';

// ─── Kit CRUD ────────────────────────────────────────────────────────────────

export interface KitInput {
  key: string;
  name: string;
  description?: string | null;
  platformKeys?: string[];
  roleTemplateKeys?: string[];
  defaultTeam?: unknown;
  welcomeTemplate?: string | null;
}

export async function listKits(agencyId: string) {
  const { prisma } = getRuntime();
  return prisma.onboarding_kits.findMany({
    where: { agency_id: agencyId },
    orderBy: { created_at: 'desc' },
  });
}

export async function getKitByKey(agencyId: string, key: string) {
  const { prisma } = getRuntime();
  return prisma.onboarding_kits.findFirst({
    where: { agency_id: agencyId, key },
  });
}

export async function getKitById(agencyId: string, id: string) {
  const { prisma } = getRuntime();
  return prisma.onboarding_kits.findFirst({
    where: { agency_id: agencyId, id },
  });
}

export async function createKit(agencyId: string, input: KitInput) {
  const { prisma } = getRuntime();
  return prisma.onboarding_kits.create({
    data: {
      agency_id: agencyId,
      key: input.key,
      name: input.name,
      description: input.description ?? null,
      platform_keys: input.platformKeys ?? [],
      role_template_keys: input.roleTemplateKeys ?? [],
      default_team: (input.defaultTeam ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      welcome_template: input.welcomeTemplate ?? null,
    },
  });
}

export async function updateKit(agencyId: string, id: string, input: Partial<KitInput>) {
  const { prisma } = getRuntime();
  const existing = await getKitById(agencyId, id);
  if (!existing) return null;
  return prisma.onboarding_kits.update({
    where: { id },
    data: {
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      platform_keys: input.platformKeys ?? existing.platform_keys,
      role_template_keys: input.roleTemplateKeys ?? existing.role_template_keys,
      default_team:
        input.defaultTeam !== undefined
          ? (input.defaultTeam as Prisma.InputJsonValue)
          : (existing.default_team as Prisma.InputJsonValue),
      welcome_template: input.welcomeTemplate ?? existing.welcome_template,
      updated_at: new Date(),
    },
  });
}

export async function deleteKit(agencyId: string, id: string) {
  const { prisma } = getRuntime();
  const existing = await getKitById(agencyId, id);
  if (!existing) return false;
  await prisma.onboarding_kits.delete({ where: { id } });
  return true;
}

// ─── Run CRUD ────────────────────────────────────────────────────────────────

export interface CreateRunInput {
  agencyId: string;
  clientId: string;
  kitId?: string | null;
  kitKey: string;
  triggeredBy?: string | null;
  summary?: RunSummary | null;
}

export async function createRun(input: CreateRunInput) {
  const { prisma } = getRuntime();
  return prisma.client_onboarding_runs.create({
    data: {
      agency_id: input.agencyId,
      client_id: input.clientId,
      kit_id: input.kitId ?? null,
      kit_key: input.kitKey,
      status: 'pending',
      triggered_by: input.triggeredBy ?? null,
      summary: (input.summary ?? Prisma.JsonNull) as unknown as Prisma.InputJsonValue,
    },
  });
}

export async function getRun(agencyId: string, runId: string) {
  const { prisma } = getRuntime();
  return prisma.client_onboarding_runs.findFirst({
    where: { agency_id: agencyId, id: runId },
  });
}

export async function getLatestRunForClient(agencyId: string, clientId: string) {
  const { prisma } = getRuntime();
  return prisma.client_onboarding_runs.findFirst({
    where: { agency_id: agencyId, client_id: clientId },
    orderBy: { created_at: 'desc' },
  });
}

export async function updateRun(
  agencyId: string,
  runId: string,
  data: {
    status?: string;
    summary?: RunSummary;
    jobId?: string;
    startedAt?: Date;
    completedAt?: Date;
  },
) {
  const { prisma } = getRuntime();
  const existing = await getRun(agencyId, runId);
  if (!existing) return null;
  return prisma.client_onboarding_runs.update({
    where: { id: runId },
    data: {
      status: data.status ?? existing.status,
      summary: data.summary !== undefined
        ? (data.summary as unknown as Prisma.InputJsonValue)
        : (existing.summary as unknown as Prisma.InputJsonValue),
      job_id: data.jobId ?? existing.job_id,
      started_at: data.startedAt ?? existing.started_at,
      completed_at: data.completedAt ?? existing.completed_at,
      updated_at: new Date(),
    },
  });
}
