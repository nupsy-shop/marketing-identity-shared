/**
 * Outbound HTTP helper for audit-destination plugins.
 *
 * Wraps `fetch` with a uniform SendResult shape and threading for the
 * provider-response override resolver (used in E2E to stub real HTTP).
 * Every plugin's wire-format client.ts should go through this helper rather
 * than calling fetch directly.
 *
 * Body handling: callers either pass `body` (any value, gets JSON.stringified
 * once here) OR `options.bodyString` (a raw string, used as-is). Use
 * `bodyString` for HMAC signing — the signed bytes and the sent bytes are
 * then guaranteed identical.
 *
 * NOTE: When Plan 4 moves client.ts files into the shared/ submodule, this
 * helper moves with them. For Plan 2 it lives here so plugin tests can run
 * in the web jest environment.
 */

import type { SendResult } from './audit-destination-plugin.interface.js';

export interface PostJsonOptions {
  agencyId: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Optional raw body string. When provided, this exact string is sent and
   * the `body` argument to postJson is ignored. Use this when the caller has
   * already serialized + signed the body and the signature must cover the
   * sent bytes verbatim.
   */
  bodyString?: string;
}

export async function postJson(
  url: string,
  body: unknown,
  options: PostJsonOptions,
): Promise<SendResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  const requestBody = options.bodyString ?? JSON.stringify(body);

  const start = Date.now();
  try {
    const controller = options.timeoutMs ? new AbortController() : undefined;
    const timer = options.timeoutMs
      ? setTimeout(() => controller!.abort(), options.timeoutMs)
      : undefined;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: requestBody,
        signal: controller?.signal,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    const elapsed = Date.now() - start;

    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        /* body unreadable, fall through */
      }
      return {
        success: false,
        error: `${res.status} ${res.statusText}${text ? `: ${text.slice(0, 200)}` : ''}`,
        responseTimeMs: elapsed,
      };
    }

    return { success: true, responseTimeMs: elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message, responseTimeMs: elapsed };
  }
}
