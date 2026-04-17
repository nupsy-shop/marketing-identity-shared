/**
 * Structured logger (Pino-backed) for the shared submodule.
 *
 * Mirrors the host-app logger surface at `lib/logger.ts`. Kept as a
 * fallback for code paths in the submodule that haven't received a
 * logger via `setRuntime()` (e.g. standalone scripts).
 *
 * Usage:
 *   import { logger } from './logger';
 *   logger.info('User logged in', { userId: '123' });
 *   const child = logger.child({ jobId, jobType });
 *
 * Configuration:
 *   LOG_LEVEL  — Pino level name (trace|debug|info|warn|error|fatal), default 'info'.
 *   NODE_ENV   — 'production' emits JSON; anything else uses pino-pretty when available.
 */

/* eslint-disable no-console, @typescript-eslint/no-explicit-any */

type MetaInput = Record<string, any> | string | string[] | undefined | null;

export interface Logger {
  debug(msg: string, meta?: MetaInput): void;
  info(msg: string, meta?: MetaInput): void;
  warn(msg: string, meta?: MetaInput): void;
  error(msg: string, meta?: MetaInput): void;
  child(bindings: Record<string, any>): Logger;
}

function normalizeMeta(meta: MetaInput): Record<string, unknown> {
  if (meta == null) return {};
  if (typeof meta === 'string') return { detail: meta };
  if (Array.isArray(meta)) return { details: meta };
  return meta as Record<string, unknown>;
}

interface PinoLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  child(bindings: Record<string, any>): PinoLike;
}

function createLogger(): Logger {
  const IS_PRODUCTION = process.env.NODE_ENV === 'production';
  const LEVEL = process.env.LOG_LEVEL || 'info';

  // Load pino if present; otherwise degrade gracefully to a console shim so
  // the submodule can still be consumed by environments that haven't pulled
  // in the host's dependencies yet.
  let pinoModule: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    pinoModule = require('pino');
  } catch {
    return createConsoleFallback({});
  }

  const pino = pinoModule.default || pinoModule;

  const base: PinoLike = pino({
    level: LEVEL,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    serializers: {
      err: pino.stdSerializers.err,
      error: pino.stdSerializers.err,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(IS_PRODUCTION
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
            },
          },
        }),
  });

  const wrap = (p: PinoLike): Logger => ({
    debug: (msg, meta) => p.debug(normalizeMeta(meta), msg),
    info: (msg, meta) => p.info(normalizeMeta(meta), msg),
    warn: (msg, meta) => p.warn(normalizeMeta(meta), msg),
    error: (msg, meta) => p.error(normalizeMeta(meta), msg),
    child: (bindings) => wrap(p.child(bindings)),
  });

  return wrap(base);
}

function createConsoleFallback(bindings: Record<string, any>): Logger {
  const emit = (level: 'debug' | 'info' | 'warn' | 'error', msg: string, meta: MetaInput) => {
    const payload = { ...bindings, ...normalizeMeta(meta) };
    const line = JSON.stringify({ level, msg, ts: new Date().toISOString(), ...payload });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (extra) => createConsoleFallback({ ...bindings, ...extra }),
  };
}

export const logger: Logger = createLogger();
