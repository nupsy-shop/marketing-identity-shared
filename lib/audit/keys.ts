/**
 * Audit STH signing key loader (Phase-1: env-var-backed).
 *
 * Phase-2 will swap this implementation for AWS KMS without changing the
 * call sites. Public surface is signWithCurrentKey/verifyWithKey/
 * getCurrentKeyId/listPublicKeys.
 *
 * Env-var convention:
 *   AUDIT_SIGNING_KEY_ID                       — current keyId in use
 *   AUDIT_SIGNING_KEY_PRIVATE_<keyId>          — base64 PKCS8 Ed25519 private
 *   AUDIT_SIGNING_KEY_PUBLIC_<keyId>           — base64 SPKI Ed25519 public
 *   AUDIT_SIGNING_KEY_VALID_FROM_<keyId>       — ISO 8601 (informational)
 *   AUDIT_SIGNING_KEY_VALID_TO_<keyId>         — ISO 8601 (informational, optional)
 *
 * Multiple keys live simultaneously during rotation. STHs carry keyId so
 * verifiers pick the right pubkey.
 */
import crypto, { KeyObject } from 'crypto';

export interface PublicKeyRecord {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyBase64: string;
  validFrom: string | null;
  validTo: string | null;
}

interface KeyCacheEntry {
  privateKey?: KeyObject;
  publicKey: KeyObject;
}

const _cache = new Map<string, KeyCacheEntry>();

function loadKey(keyId: string): KeyCacheEntry {
  const cached = _cache.get(keyId);
  if (cached) return cached;
  const pubB64 = process.env[`AUDIT_SIGNING_KEY_PUBLIC_${keyId}`];
  if (!pubB64) {
    throw new Error(`[audit] missing env var AUDIT_SIGNING_KEY_PUBLIC_${keyId}`);
  }
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(pubB64, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const privB64 = process.env[`AUDIT_SIGNING_KEY_PRIVATE_${keyId}`];
  let privateKey: KeyObject | undefined;
  if (privB64) {
    privateKey = crypto.createPrivateKey({
      key: Buffer.from(privB64, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
  }
  const entry = { privateKey, publicKey };
  _cache.set(keyId, entry);
  return entry;
}

export function getCurrentKeyId(): string {
  const id = process.env.AUDIT_SIGNING_KEY_ID;
  if (!id) throw new Error('[audit] AUDIT_SIGNING_KEY_ID env var not set');
  return id;
}

export function getSigningPrivateKey(): KeyObject {
  const id = getCurrentKeyId();
  const privB64 = process.env[`AUDIT_SIGNING_KEY_PRIVATE_${id}`];
  if (!privB64) {
    throw new Error(`[audit] missing env var AUDIT_SIGNING_KEY_PRIVATE_${id}`);
  }
  const entry = loadKey(id);
  // entry.privateKey is guaranteed to be set because privB64 is present above
  return entry.privateKey!;
}

export function signWithCurrentKey(message: Buffer): Buffer {
  return crypto.sign(null, message, getSigningPrivateKey());
}

export function verifyWithKey(keyId: string, message: Buffer, signature: Buffer): boolean {
  try {
    const entry = loadKey(keyId);
    return crypto.verify(null, message, entry.publicKey, signature);
  } catch {
    return false;
  }
}

export function listPublicKeys(): PublicKeyRecord[] {
  const ids = new Set<string>();
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^AUDIT_SIGNING_KEY_PUBLIC_(.+)$/);
    if (m) ids.add(m[1]);
  }
  return Array.from(ids).map(keyId => ({
    keyId,
    algorithm: 'ed25519' as const,
    publicKeyBase64: process.env[`AUDIT_SIGNING_KEY_PUBLIC_${keyId}`]!,
    validFrom: process.env[`AUDIT_SIGNING_KEY_VALID_FROM_${keyId}`] ?? null,
    validTo: process.env[`AUDIT_SIGNING_KEY_VALID_TO_${keyId}`] ?? null,
  }));
}

// Test seam.
export function __resetKeyCacheForTest(): void { _cache.clear(); }
