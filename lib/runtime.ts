/**
 * Runtime Service Locator
 *
 * Plugin processors run in the shared submodule but need access to
 * host-specific services (Prisma, logger) that vary between the web app
 * and the worker. The host registers these at startup; processors
 * retrieve them at runtime.
 *
 * Usage (host — worker or web app):
 *   import { setRuntime } from '../shared/lib/runtime.js';
 *   setRuntime({ prisma, logger });
 *
 * Usage (plugin processor):
 *   import { getRuntime } from '../../../../lib/runtime.js';
 *   const { prisma, logger } = getRuntime();
 */

import { resolveProviderOverrideViaPrisma } from './http/provider-override-resolver.js';

export interface RuntimeServices {
  prisma: any;
  logger: {
    info(msg: string, ctx?: Record<string, unknown>): void;
    warn(msg: string, ctx?: Record<string, unknown>): void;
    error(msg: string, ctx?: Record<string, unknown>): void;
    debug(msg: string, ctx?: Record<string, unknown>): void;
  };
  /**
   * Optional job enqueue callback provided by the host.
   * Allows processors to dispatch follow-up jobs (e.g. jml_process_lifecycle)
   * without coupling to the host's queue implementation.
   *
   * @param jobType - Job type identifier (e.g. 'jml_process_lifecycle')
   * @param data - Job payload (must include tenantId for tenant-scoped jobs)
   * @returns Job ID or null if unavailable
   */
  enqueueJob?: (jobType: string, data: Record<string, unknown>) => Promise<string | null>;
  /**
   * Optional Google Workspace access-token resolver, registered by the host.
   * Used by the platform-health liveness probe to authenticate a minimal
   * `admin.directory.users.list` call. Must execute inside the agency's
   * tenant context (RLS). Returns null when no active token is available
   * or the refresh flow failed — the liveness check treats null as an
   * auth error and the checker flips the source to 'needs_reauth'.
   *
   * Contract: read-only. Resolver must not rotate or mutate credentials.
   *
   * @param agencyId - Agency whose GWS token to resolve
   * @returns Access token string, or null if unavailable
   */
  resolveGwsAccessToken?: (agencyId: string) => Promise<string | null>;
  /**
   * Optional provider-response override resolver, registered by the host.
   * Plugin processors that make outbound HTTP calls to third-party IdPs
   * (Keycloak `.well-known/openid-configuration`, GWS, Entra, etc.) consult
   * this bridge BEFORE dialling the real endpoint. When a matching override
   * row exists in `provider_response_overrides` it short-circuits the
   * network call with the forced status/body so E2E tests can drive the
   * "discovery failed" / "malformed payload" branches deterministically.
   *
   * Fail-closed: resolvers should return null on any error (never throw)
   * and must refuse to apply overrides outside E2E mode. The shared
   * contract takes `provider` as a wide `string` to keep this module free
   * of web-app types; hosts narrow it back to their provider union.
   *
   * @param agencyId - Agency owning the override row (RLS scope).
   * @param provider - Short provider name (e.g. 'keycloak', 'gws').
   * @param url - Full outbound URL; matched against row.endpoint_match.
   * @returns Forced response envelope, or null to let the real call run.
   */
  resolveProviderOverride?: (
    agencyId: string,
    provider: string,
    url: string,
  ) => Promise<{ status: number; body: unknown; delayMs?: number } | null>;
  /**
   * Optional provider-auth failure counter (record).
   *
   * Called at user-call boundaries — specifically the null-return paths of
   * `getValidAccessToken` — to mark that a per-request token refresh failed.
   * The platform-health probe consults the rolling count on its next tick
   * via {@link getProviderAuthFailureCount} so a sustained pattern of
   * per-request flaps surfaces as `degraded`, even when the synthetic
   * probe just succeeded against the same provider.
   *
   * Fire-and-forget: never throws, never blocks the caller. Hosts back this
   * with a Redis INCR + TTL (see lib/platform-health/provider-auth-failure-
   * counter.ts in the web app and worker repos for the canonical impl).
   *
   * Scope: keyed by (agencyId, pluginKey). The shared contract intentionally
   * keeps `pluginKey` as a plain string so it works for every identity
   * plugin without referencing the host's plugin union.
   *
   * Documented: docs/superpowers/specs/2026-05-25-trevox-gws-probe-miss-rca.md
   *             — Recommendation A in the parent web repo.
   *
   * @param agencyId  - Tenant scope for the counter.
   * @param pluginKey - Identity-source plugin key (e.g. 'google-workspace').
   */
  recordProviderAuthFailure?: (agencyId: string, pluginKey: string) => Promise<void>;
  /**
   * Optional provider-auth failure counter (read).
   *
   * Companion to {@link recordProviderAuthFailure}. The platform-health
   * orchestrator calls this after a successful synthetic probe — if the
   * rolling count over `windowSeconds` is at or above the configured
   * threshold, the orchestrator mutates the otherwise-OK liveness result
   * to ok:false / errorCategory:'unknown' so the checker maps the source
   * to `degraded` and emits the matching state-change + notification.
   *
   * Returns 0 when the host hasn't registered a counter (web-only
   * deployments, unit tests). Never throws; backing impl is bounded.
   *
   * @param agencyId      - Tenant scope.
   * @param pluginKey     - Identity-source plugin key.
   * @param windowSeconds - Lookback window. The counter is approximate —
   *                        backed by a TTL'd Redis key, not a sliding
   *                        window — so callers must keep this aligned with
   *                        the host's recordProviderAuthFailure TTL.
   */
  getProviderAuthFailureCount?: (
    agencyId: string,
    pluginKey: string,
    windowSeconds: number,
  ) => Promise<number>;
  /**
   * Optional revocation engine, registered by the host. Used by the
   * workflow engine's `revoke_access` action. When undefined (e.g. in the
   * Bull worker, where webpack's require.context-based plugin loader is
   * not available), `revoke_access` actions will fail loudly rather than
   * silently no-op — callers can then route to a manual remediation task.
   *
   * Signature mirrors lib/jml/revocation-engine.revokeAllPlatformAccess.
   */
  revokeAllPlatformAccess?: (
    agencyId: string,
    directoryUserId: string,
    reason: string,
    userEmail?: string,
  ) => Promise<Record<string, unknown>>;

  /**
   * Optional reprovision engine, registered by the host. Used by the
   * workflow engine's `restore_before_state` action to re-grant access
   * that was previously revoked by automation. See `revokeAllPlatformAccess`
   * for runtime availability semantics.
   */
  reprovisionAccess?: (
    agencyId: string,
    userId: string,
    reason: string,
  ) => Promise<{ reprovisioned?: number } | undefined>;

  /**
   * Optional platform-revoke registry, registered by the host. Keyed by
   * plugin key (e.g. 'ga4', 'meta'). Each function revokes a single
   * unauthorized grant on that platform.
   *
   * Worker leaves this undefined entirely — auto-revoke handlers fall
   * back to flag-only behavior with a clear note. See `flag_platform_audit_event`
   * for the fallback path.
   *
   * Web registers entries per platform via dynamic imports (avoid eager
   * load of platform plugin chains on every shared-runtime-init).
   *
   * Returns `{ revoked: boolean, details?: string }` — `revoked: false`
   * indicates the revoke API rejected the request (e.g. binding not found,
   * already revoked, permission error). The handler audits this state and
   * still returns success at the workflow level.
   */
  revokePlatformAccess?: {
    [pluginKey: string]: (
      agencyId: string,
      userEmail: string,
      resource: { type?: string; id?: string; name?: string } | undefined,
    ) => Promise<{ revoked: boolean; details?: string }>;
  };
}

// Use globalThis to ensure a single instance across compiled modules.
// When tsc compiles both src/ and shared/, each gets its own module scope.
// globalThis is the only reliable shared state across module boundaries.
const RUNTIME_KEY = Symbol.for('accesshive.runtime');

export function setRuntime(services: RuntimeServices): void {
  // Default the provider-override resolver so EVERY host honours
  // `provider_response_overrides` — including the worker, which (unlike the web
  // app) has no web-side resolver to inject. Hosts that register their own
  // resolver keep it unchanged; hosts that don't get the shared, fail-closed,
  // is_test_tenant-gated implementation. Real-customer traffic is never routed
  // through a stub (the gate short-circuits on is_test_tenant=false).
  const withDefaults: RuntimeServices = services.resolveProviderOverride
    ? services
    : {
        ...services,
        resolveProviderOverride: (agencyId, provider, url) =>
          resolveProviderOverrideViaPrisma(
            services.prisma,
            services.logger,
            agencyId,
            provider,
            url,
          ),
      };
  (globalThis as any)[RUNTIME_KEY] = withDefaults;
}

export function clearRuntime(): void {
  (globalThis as Record<PropertyKey, unknown>)[RUNTIME_KEY] = undefined;
}

export function getRuntime(): RuntimeServices {
  const runtime = (globalThis as any)[RUNTIME_KEY] as RuntimeServices | undefined;
  if (!runtime) {
    throw new Error(
      'Runtime services not initialized. Call setRuntime({ prisma, logger }) before loading plugin processors.',
    );
  }
  return runtime;
}
