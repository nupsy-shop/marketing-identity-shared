/**
 * Structured logger with JSON output and configurable log levels.
 *
 * Usage:
 *   import { logger } from '@/lib/logger';
 *   logger.info('User logged in', { userId: '123', agency: 'acme' });
 *   logger.error('Failed to create grant', { grantId, error: err.message });
 *
 * Configuration:
 *   LOG_LEVEL=debug|info|warn|error (default: 'info')
 *   LOG_FORMAT=json|text (default: 'json' in production, 'text' in development)
 */

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL || 'info'] || LOG_LEVELS.info;
const IS_JSON = process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';

function formatMessage(level, msg, ctx) {
  if (IS_JSON) {
    return JSON.stringify({ level, msg, ts: new Date().toISOString(), ...ctx });
  }
  const prefix = `[${level.toUpperCase()}] ${new Date().toISOString()}`;
  const context = ctx && Object.keys(ctx).length > 0 ? ` ${JSON.stringify(ctx)}` : '';
  return `${prefix} ${msg}${context}`;
}

export const logger = {
  debug(msg, ctx = {}) {
    if (CURRENT_LEVEL <= LOG_LEVELS.debug) console.log(formatMessage('debug', msg, ctx));
  },
  info(msg, ctx = {}) {
    if (CURRENT_LEVEL <= LOG_LEVELS.info) console.log(formatMessage('info', msg, ctx));
  },
  warn(msg, ctx = {}) {
    if (CURRENT_LEVEL <= LOG_LEVELS.warn) console.warn(formatMessage('warn', msg, ctx));
  },
  error(msg, ctx = {}) {
    if (CURRENT_LEVEL <= LOG_LEVELS.error) console.error(formatMessage('error', msg, ctx));
  },
};
