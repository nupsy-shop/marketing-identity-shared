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
