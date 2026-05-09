/**
 * RFC 8785 JCS (JSON Canonicalization Scheme) wrapper.
 *
 * Used by the audit publisher and the customer-side verifier CLI.
 * The verifier MUST use this exact same library and version, so the
 * canonical bytes are byte-identical on both sides.
 */
import crypto from 'crypto';

let _canonicalize: ((value: unknown) => string | undefined) | null = null;

async function getCanonicalizeFunction() {
  if (_canonicalize !== null) {
    return _canonicalize;
  }
  const mod = await import('canonicalize');
  _canonicalize = mod.default;
  return _canonicalize;
}

export async function canonicalizeBody(value: unknown): Promise<string> {
  const canonicalizeFn = await getCanonicalizeFunction();
  const result = canonicalizeFn(value);
  if (result === undefined) {
    throw new Error('[audit] canonicalize() returned undefined; input contained a non-serializable value');
  }
  return result;
}

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
