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

let _runtime: RuntimeServices | null = null;

export function setRuntime(services: RuntimeServices): void {
  _runtime = services;
}

export function getRuntime(): RuntimeServices {
  if (!_runtime) {
    throw new Error(
      'Runtime services not initialized. Call setRuntime({ prisma, logger }) before loading plugin processors.',
    );
  }
  return _runtime;
}
