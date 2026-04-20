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
}

// Use globalThis to ensure a single instance across compiled modules.
// When tsc compiles both src/ and shared/, each gets its own module scope.
// globalThis is the only reliable shared state across module boundaries.
const RUNTIME_KEY = Symbol.for('accesshive.runtime');

export function setRuntime(services: RuntimeServices): void {
  (globalThis as any)[RUNTIME_KEY] = services;
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
