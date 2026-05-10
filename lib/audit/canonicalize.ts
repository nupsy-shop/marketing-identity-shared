/**
 * RFC 8785 JCS (JSON Canonicalization Scheme) wrapper.
 *
 * Used by the audit publisher and the customer-side verifier CLI.
 * The verifier MUST use this exact same library and version, so the
 * canonical bytes are byte-identical on both sides.
 */
// `canonicalize` is a CommonJS package (module.exports = function).
// NodeNext-mode TypeScript (used by the bull worker) resolves the default
// import to a namespace object whose call signature isn't visible. The web
// app (Next.js, ESModule mode with esModuleInterop) and the verifier-cli
// (CommonJS) handle a default-import directly. Cast through `unknown` to
// give every consumer a callable function regardless of module mode.
import canonicalizeMod from 'canonicalize';
import crypto from 'crypto';

const canonicalize = canonicalizeMod as unknown as (v: unknown) => string | undefined;

export function canonicalizeBody(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error('[audit] canonicalize() returned undefined; input contained a non-serializable value');
  }
  return result;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
