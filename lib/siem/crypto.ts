/**
 * SIEM Credential Encryption — AES-256-GCM encrypt/decrypt.
 *
 * Encrypts sensitive fields (tokens, passwords, client keys, HMAC secrets)
 * before storage in the siem_config JSONB column.
 *
 * Uses SIEM_ENCRYPTION_KEY env var (or LAGO_API_KEY as fallback seed).
 * Encrypted values are prefixed with "encrypted:aes256:" for identification.
 */

import crypto from 'crypto';

const PREFIX = 'encrypted:aes256:';
const ALGORITHM = 'aes-256-gcm' as const;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

// ─── Types ──────────────────────────────────────────────────────────────────

interface SiemAuthConfig {
  token?: string;
  password?: string;
  clientKey?: string;
  hmacSecret?: string;
  [key: string]: unknown;
}

// ─── Key Derivation ──────────────────────────────────────────────────────────

function getEncryptionKey(): Buffer {
  const raw = process.env.SIEM_ENCRYPTION_KEY || process.env.LAGO_API_KEY;
  if (!raw) {
    throw new Error('SIEM_ENCRYPTION_KEY or LAGO_API_KEY environment variable is required for credential encryption');
  }
  // Derive a 256-bit key from the raw value using SHA-256
  return crypto.createHash('sha256').update(raw).digest();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a value is already encrypted.
 */
export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext credential value.
 *
 * @returns Encrypted value with "encrypted:aes256:" prefix
 */
export function encryptCredential(plaintext: string): string {
  if (!plaintext || typeof plaintext !== 'string') return plaintext;
  if (isEncrypted(plaintext)) return plaintext; // Already encrypted

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const tag = cipher.getAuthTag();

  // Format: prefix + iv(hex) + : + tag(hex) + : + ciphertext(hex)
  return PREFIX + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

/**
 * Decrypt an encrypted credential value.
 *
 * @returns Decrypted plaintext
 */
export function decryptCredential(ciphertext: string): string {
  if (!ciphertext || typeof ciphertext !== 'string') return ciphertext;
  if (!isEncrypted(ciphertext)) return ciphertext; // Not encrypted

  const key = getEncryptionKey();
  const data = ciphertext.slice(PREFIX.length);
  const parts = data.split(':');

  if (parts.length !== 3) {
    throw new Error('Invalid encrypted credential format');
  }

  const [ivHex, tagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Mask a credential value for API responses.
 * Shows only the last 4 characters.
 */
export function maskCredential(value: string): string | null {
  if (!value || typeof value !== 'string') return null;

  // If encrypted, decrypt first to get last 4 chars
  let plain: string;
  try {
    plain = isEncrypted(value) ? decryptCredential(value) : value;
  } catch {
    return '****...????';
  }

  if (plain.length <= 4) return '****';
  return '****...' + plain.slice(-4);
}

const SENSITIVE_FIELDS: readonly string[] = ['token', 'password', 'clientKey', 'hmacSecret'] as const;

/**
 * Encrypt all sensitive fields in a SIEM auth config object.
 */
export function encryptAuthCredentials(auth: SiemAuthConfig): SiemAuthConfig;
export function encryptAuthCredentials(auth: null | undefined): null | undefined;
export function encryptAuthCredentials(auth: SiemAuthConfig | null | undefined): SiemAuthConfig | null | undefined {
  if (!auth) return auth;

  const encrypted = { ...auth };

  for (const field of SENSITIVE_FIELDS) {
    const value = encrypted[field];
    if (typeof value === 'string' && !isEncrypted(value)) {
      encrypted[field] = encryptCredential(value);
    }
  }

  return encrypted;
}

/**
 * Decrypt all sensitive fields in a SIEM auth config object.
 */
export function decryptAuthCredentials(auth: SiemAuthConfig): SiemAuthConfig;
export function decryptAuthCredentials(auth: null | undefined): null | undefined;
export function decryptAuthCredentials(auth: SiemAuthConfig | null | undefined): SiemAuthConfig | null | undefined {
  if (!auth) return auth;

  const decrypted = { ...auth };

  for (const field of SENSITIVE_FIELDS) {
    const value = decrypted[field];
    if (typeof value === 'string' && isEncrypted(value)) {
      decrypted[field] = decryptCredential(value);
    }
  }

  return decrypted;
}

/**
 * Mask all sensitive fields in a SIEM auth config object for API responses.
 */
export function maskAuthCredentials(auth: SiemAuthConfig): SiemAuthConfig;
export function maskAuthCredentials(auth: null | undefined): null | undefined;
export function maskAuthCredentials(auth: SiemAuthConfig | null | undefined): SiemAuthConfig | null | undefined {
  if (!auth) return auth;

  const masked = { ...auth };

  for (const field of SENSITIVE_FIELDS) {
    if (masked[field]) {
      masked[field] = maskCredential(masked[field] as string) ?? undefined;
    }
  }

  return masked;
}
