/**
 * E2E Provider Response Override Resolver — Shared Submodule Copy
 *
 * Mirror of the web-app's `lib/http/provider-override-resolver.ts`, adapted
 * for the shared submodule runtime (no `@/` aliases; Prisma is obtained from
 * the runtime service locator registered by the host).
 *
 * Why a parallel copy?
 *   The shared submodule ships to both the web app and the Bull worker. Its
 *   modules cannot import from the parent repo — `@/lib/*` doesn't exist
 *   when compiled inside the worker. `shared/lib/platform-health/liveness.ts`
 *   already establishes this pattern (inline override lookup via runtime
 *   Prisma); this file extracts it into a reusable helper so every
 *   provider client in `shared/plugins/identity/*` can call the same hook.
 *
 * Contract (matches parent resolver exactly):
 *   - Fail-closed: every error path returns `null` (never throws).
 *   - Gated: only active when NODE_ENV !== 'production' OR E2E_ENABLED === 'true'.
 *   - Agency-scoped: every read carries a `where.agency_id` clause.
 *   - No hardcoded fallbacks: absence of a row is absence of an override.
 *
 * Matching rules (identical to parent):
 *   - `endpoint_match` is a plain substring of the outbound URL.
 *   - Longest substring wins (most specific). Ties → oldest row wins.
 */

import { getRuntime } from '../runtime.js';

export type ProviderName =
  | 'gws'
  | 'entra'
  | 'slack'
  | 'lago'
  | 'sendgrid'
  | 'keycloak';

export interface ProviderOverride {
  /** HTTP status to return in place of the real response. */
  status: number;
  /** Response body. `null` means "return an empty body". */
  body: unknown;
  /** Milliseconds to sleep before returning (simulates slow providers). */
  delayMs: number;
}

/**
 * Cheap gate: is the override table even allowed to be consulted in this env?
 *
 * Kept as a function (not a module-scope const) so each call samples
 * `process.env` afresh — test harnesses flip `E2E_ENABLED` between runs.
 */
function overridesEnabled(): boolean {
  if (process.env.NODE_ENV !== 'production') return true;
  return process.env.E2E_ENABLED === 'true';
}

/**
 * Resolve a provider-response override for this outbound call.
 *
 * @param agencyId  The agency whose call is being made. A missing/empty
 *                  agency id always returns null (fail-closed, production
 *                  path untouched).
 * @param provider  One of the known provider tokens.
 * @param url       The fully-qualified outbound URL.
 */
export async function resolveProviderOverride(
  agencyId: string,
  provider: ProviderName,
  url: string,
): Promise<ProviderOverride | null> {
  if (!overridesEnabled()) return null;
  if (!agencyId || !provider || !url) return null;

  try {
    const { prisma } = getRuntime();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (await (prisma as any).provider_response_overrides.findMany({
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

    if (rows.length === 0) return null;

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
  } catch {
    // Fail-closed. Table may not exist yet (pre-migration env), the runtime
    // may not have a prisma registered (stripped-down build / unit test),
    // or the DB may be down. Application callers MUST continue to their
    // real HTTP call on null.
    return null;
  }
}

/**
 * Utility: honour the override's `delayMs` before the caller returns it.
 * Kept as a named helper so tests can spy on it and call sites read naturally.
 */
export async function applyOverrideDelay(override: ProviderOverride): Promise<void> {
  if (override.delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, override.delayMs));
  }
}
