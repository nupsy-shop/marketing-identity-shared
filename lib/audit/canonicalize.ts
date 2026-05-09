/**
 * RFC 8785 JCS (JSON Canonicalization Scheme) wrapper.
 *
 * Used by the audit publisher and the customer-side verifier CLI.
 * The verifier MUST use this exact same library and version, so the
 * canonical bytes are byte-identical on both sides.
 */
import canonicalize from 'canonicalize';
import crypto from 'crypto';

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
