/**
 * Shared provider-response override resolver (runtime-Prisma flavour).
 *
 * Port of the web app's lib/http/provider-override-resolver.ts into the shared
 * submodule so the BULL WORKER — not just the web app — can honour
 * `provider_response_overrides` rows. The web wires its own implementation into
 * the runtime; hosts that do NOT inject one (notably the worker) fall back to
 * this via `setRuntime` (see ./runtime.ts), so E2E provider overrides work the
 * same on the async worker path as on the web path.
 *
 * Same invariants as the web original:
 *   - Fail-closed: every error path returns `null` (never throws); the caller
 *     proceeds to its real HTTP call on `null`.
 *   - Gated per-agency by data: only consults the table when
 *     `agencies.is_test_tenant = true`. Real-customer agencies (default `false`)
 *     bypass entirely — identical behaviour in dev / staging / prod.
 *   - Agency-scoped: every read carries `where.agency_id`.
 *   - Matching: `endpoint_match` is a plain substring of the outbound URL;
 *     longest match wins (most specific); ties broken by oldest `created_at`.
 *
 * Takes `prisma` + `logger` as arguments (no host-type imports) so it is safe to
 * compile in both the web app and the worker. `prisma` is the host's client
 * (typed `any` in the shared runtime); the `provider_response_overrides` /
 * `agencies.is_test_tenant` schema must be present in the host (the worker's
 * shared processors already reference these — gws-create-user, entra-create-user).
 */

export interface ProviderOverrideResult {
  status: number;
  body: unknown;
  delayMs: number;
}

interface MinimalLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Gate: may the override table be consulted for this agency?
 * Single source of truth: `agencies.is_test_tenant`. Fail-closed on any error.
 */
async function overridesEnabled(
  prisma: any,
  logger: MinimalLogger,
  agencyId: string,
): Promise<boolean> {
  try {
    const agency = await prisma.agencies.findUnique({
      where: { id: agencyId },
      select: { is_test_tenant: true },
    });
    return agency?.is_test_tenant === true;
  } catch (err: unknown) {
    logger.warn(
      '[shared/provider-override-resolver] overridesEnabled lookup failed; failing closed',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return false;
  }
}

/**
 * Resolve a provider-response override for an outbound call, using the host's
 * Prisma client. Returns the forced response, or `null` to let the real call run.
 */
export async function resolveProviderOverrideViaPrisma(
  prisma: any,
  logger: MinimalLogger,
  agencyId: string,
  provider: string,
  url: string,
): Promise<ProviderOverrideResult | null> {
  if (!agencyId || !provider || !url) return null;
  if (!(await overridesEnabled(prisma, logger, agencyId))) return null;

  try {
    const rows = (await prisma.provider_response_overrides.findMany({
      where: { agency_id: agencyId, provider },
      select: {
        endpoint_match: true,
        status: true,
        body_json: true,
        delay_ms: true,
        created_at: true,
      },
    })) as Array<{
      endpoint_match: string;
      status: number;
      body_json: unknown;
      delay_ms: number;
      created_at: Date;
    }>;

    if (!rows || rows.length === 0) return null;

    // Longest substring wins (most specific). Ties → oldest row wins.
    const matches = rows
      .filter((r) => r.endpoint_match.length > 0 && url.includes(r.endpoint_match))
      .sort((a, b) => {
        if (b.endpoint_match.length !== a.endpoint_match.length) {
          return b.endpoint_match.length - a.endpoint_match.length;
        }
        return a.created_at.getTime() - b.created_at.getTime();
      });

    if (matches.length === 0) return null;
    const row = matches[0]!;
    return {
      status: row.status,
      body: row.body_json ?? null,
      delayMs: row.delay_ms ?? 0,
    };
  } catch (err: unknown) {
    // Fail-closed: table may be absent (pre-migration / schema drift), DB down,
    // etc. Callers MUST continue to their real call on null.
    logger.warn(
      '[shared/provider-override-resolver] lookup failed (non-fatal, falling through)',
      { error: err instanceof Error ? err.message : String(err) },
    );
    return null;
  }
}
