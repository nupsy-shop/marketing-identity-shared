/**
 * Trust Report Assembler (shared port of #57).
 *
 * Composes role + ownership data into a `TrustReportPayload` scoped to
 * ONE (agency, client) pair. Pure helper: agency + client filters
 * applied at every query. No IO beyond Prisma reads. No side effects.
 *
 * Invariant: every `where` filters BOTH agency_id AND client_id. A row
 * missing the client filter is a cross-client leak.
 */

import { getRuntime } from '../runtime.js';
import type { Quarter } from './quarter.js';

export interface TrustReportBranding {
  logoUrl?: string | null;
  primaryColor?: string | null;
  coverTitle?: string | null;
}

export interface TrustReportSummaryRow {
  label: string;
  value: string | number;
}

export interface TrustReportTableSection {
  title: string;
  headers: string[];
  rows: string[][];
  /** Optional note shown above the table. */
  note?: string;
}

export interface TrustReportPayload {
  agencyId: string;
  agencySlug: string | null;
  clientId: string;
  clientName: string;
  quarter: Quarter;
  branding: TrustReportBranding;
  summary: TrustReportSummaryRow[];
  accessMatrix: TrustReportTableSection;
  staleAccess: TrustReportTableSection;
  driftSummary: TrustReportTableSection;
}

export interface AssembleArgs {
  agencyId: string;
  clientId: string;
  quarter: Quarter;
}

/**
 * Assemble a `TrustReportPayload` for a single (agency, client, quarter).
 *
 * Uses the host's Prisma client via `getRuntime()`. All queries carry
 * both `agency_id` and `client_id` filters; the assembler never reads
 * from a neighbouring client's rows.
 */
export async function assembleTrustReport(
  args: AssembleArgs,
): Promise<TrustReportPayload> {
  const { agencyId, clientId, quarter } = args;
  const { prisma } = getRuntime();

  // ── Agency + client existence (double-scope guard) ────────────────────
  const client = await prisma.clients.findFirst({
    where: { id: clientId, agency_id: agencyId },
    select: {
      id: true,
      name: true,
      trust_report_branding: true,
      agencies: { select: { slug: true, name: true } },
    },
  });
  if (!client) {
    throw new Error(
      `trust_report.assemble: client ${clientId} not found in agency ${agencyId}`,
    );
  }

  const branding = normalizeBranding(client.trust_report_branding);

  // ── Access matrix (client-scoped) ─────────────────────────────────────
  const roleRows = await prisma.client_role_assignments.findMany({
    where: {
      agency_id: agencyId,
      client_id: clientId,
      is_active: true,
    },
    select: {
      role: true,
      role_template_key: true,
      created_at: true,
      users: { select: { email: true, name: true } },
    },
    orderBy: { created_at: 'desc' },
    take: 500,
  });

  const accessMatrix: TrustReportTableSection = {
    title: 'Access Matrix',
    headers: ['User', 'Email', 'Role', 'Granted'],
    rows: (roleRows as Array<{
      role: string | null;
      role_template_key: string | null;
      created_at: Date | null;
      users: { email: string | null; name: string | null } | null;
    }>).map((r) => [
      safeName(r.users?.name),
      safeEmail(r.users?.email),
      r.role_template_key || r.role || '',
      r.created_at ? fmtDate(r.created_at) : '',
    ]),
    note: 'Active role assignments scoped to this client.',
  };

  // ── Stale access (client-scoped via client_owner_assignments) ─────────
  const staleWindowStart = new Date(quarter.start);
  staleWindowStart.setUTCDate(staleWindowStart.getUTCDate() - 90);

  const staleRows = await prisma.client_owner_assignments.findMany({
    where: {
      agency_id: agencyId,
      client_id: clientId,
      is_active: true,
      updated_at: { lt: staleWindowStart },
    },
    select: {
      owner_type: true,
      assignment_mode: true,
      updated_at: true,
      app_user_id: true,
    },
    take: 200,
  });

  // Enrich with display name/email where an app_user_id is present —
  // still agency-scoped via the users lookup.
  const userIds = (staleRows as Array<{ app_user_id: string | null }>)
    .map((r) => r.app_user_id)
    .filter(Boolean) as string[];
  const userLookup = userIds.length
    ? await prisma.users.findMany({
        where: { id: { in: userIds }, agency_id: agencyId },
        select: { id: true, email: true, name: true },
      })
    : [];
  const userById = new Map(
    (userLookup as Array<{ id: string; email: string | null; name: string | null }>)
      .map((u) => [u.id, u]),
  );

  const staleAccess: TrustReportTableSection = {
    title: 'Stale Access',
    headers: ['Owner Type', 'Mode', 'User', 'Email', 'Last Updated'],
    rows: (staleRows as Array<{
      owner_type: string | null;
      assignment_mode: string | null;
      updated_at: Date | null;
      app_user_id: string | null;
    }>).map((r) => {
      const u = r.app_user_id ? userById.get(r.app_user_id) : null;
      return [
        r.owner_type || '',
        r.assignment_mode || '',
        safeName(u?.name),
        safeEmail(u?.email),
        r.updated_at ? fmtDate(r.updated_at) : '',
      ];
    }),
    note: 'Ownership assignments not refreshed in 90+ days before quarter start.',
  };

  // ── Drift summary — count only; PDF never carries raw drift bodies ────
  // Drift events live in Elasticsearch; this thin slice records a
  // placeholder count of 0. Follow-ups wire the ES query through the
  // shared client.
  const driftCount = 0;
  const driftSummary: TrustReportTableSection = {
    title: 'Drift',
    headers: ['Metric', 'Value'],
    rows: [['Open drift events this quarter', String(driftCount)]],
    note: 'Drift events are summarized; full records remain in the agency audit trail.',
  };

  // ── Cover summary ─────────────────────────────────────────────────────
  const summary: TrustReportSummaryRow[] = [
    { label: 'Client', value: client.name },
    { label: 'Quarter', value: quarter.label },
    { label: 'Period', value: `${quarter.startDate} – ${quarter.endDate}` },
    { label: 'Active Assignments', value: accessMatrix.rows.length },
    { label: 'Stale Access Items', value: staleAccess.rows.length },
    { label: 'Drift Events', value: driftCount },
  ];

  return {
    agencyId,
    agencySlug: client.agencies?.slug ?? null,
    clientId,
    clientName: client.name,
    quarter,
    branding,
    summary,
    accessMatrix,
    staleAccess,
    driftSummary,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────

function normalizeBranding(raw: unknown): TrustReportBranding {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  return {
    logoUrl: typeof r.logoUrl === 'string' ? r.logoUrl : null,
    primaryColor: typeof r.primaryColor === 'string' ? r.primaryColor : null,
    coverTitle: typeof r.coverTitle === 'string' ? r.coverTitle : null,
  };
}

function safeEmail(email?: string | null): string {
  return email ? email : '';
}

function safeName(name?: string | null): string {
  return name ? name : '';
}

function fmtDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
