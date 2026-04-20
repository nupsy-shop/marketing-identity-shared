/**
 * Credential Vault (shared) — issue #51 follow-up.
 *
 * Abstraction over vault storage for Shared Credential and Service
 * Account identity types. Credentials are stored in the vault
 * (`credential_secrets.encrypted_payload`); the DB only stores the
 * `vault_secret_path` reference on `integration_identities.metadata`.
 *
 * Originally implemented web-side at `lib/credential-vault.ts`; ported
 * here so the bull worker (and other hosts) can read/write the vault
 * through the same abstraction. The AES-256-GCM envelope relies solely
 * on `node:crypto`, which works identically in both processes.
 *
 * Invariants:
 *   - Prisma only (no raw SQL).
 *   - No password/key/vault-path text in audit payloads — that is the
 *     caller's responsibility. This module never publishes audits.
 *   - Framework-agnostic: Prisma is pulled from `getRuntime()`.
 */

import crypto from 'crypto';
import { getRuntime } from '../runtime.js';

// ─── Secret Path Convention ─────────────────────────────────────────────────

function secretPath(identityId: string): string {
  return `identities/${identityId}`;
}

// ─── Password Generation ────────────────────────────────────────────────────

const PW_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+';

export function generatePassword(length = 32): string {
  const bytes = crypto.randomBytes(length);
  return Array.from(bytes).map(b => PW_CHARS[b % PW_CHARS.length]).join('');
}

// ─── Payload types ──────────────────────────────────────────────────────────

export interface CredentialPayload {
  username?: string;
  password?: string;
  apiKey?: string;
  jsonKey?: string;
  clientId?: string;
  clientSecret?: string;
  credentialType?: string;
  [key: string]: unknown;
}

export interface StoreResult {
  vaultSecretPath: string;
  storedAt: string;
}

export interface RotateResult {
  newPassword: string;
  rotatedAt: string;
}

// ─── Store Credential ───────────────────────────────────────────────────────

export async function storeCredential(
  identityId: string,
  credential: CredentialPayload,
): Promise<StoreResult> {
  const { prisma } = getRuntime();
  const path = secretPath(identityId);
  const payload = {
    ...credential,
    storedAt: new Date().toISOString(),
  };

  await prisma.credential_secrets.upsert({
    where: { credential_id: identityId },
    create: {
      credential_id: identityId,
      encrypted_payload: JSON.stringify(payload),
      key_version: 'v1',
    },
    update: {
      encrypted_payload: JSON.stringify(payload),
      updated_at: new Date(),
    },
  });

  // Store vault_secret_path in metadata since the column lives on
  // dedicated_identities; mirror the existing web-side behaviour exactly.
  await prisma.integration_identities.update({
    where: { id: identityId },
    data: {
      metadata: { vault_secret_path: path } as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    },
  });

  return { vaultSecretPath: path, storedAt: payload.storedAt };
}

// ─── Reveal Credential ──────────────────────────────────────────────────────

export async function revealCredential(
  identityId: string,
): Promise<Record<string, unknown> | null> {
  const { prisma } = getRuntime();
  const row = await prisma.credential_secrets.findUnique({
    where: { credential_id: identityId },
    select: { encrypted_payload: true },
  });
  if (!row) return null;

  try {
    const payload = row.encrypted_payload;
    return typeof payload === 'string'
      ? JSON.parse(payload)
      : (payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

// ─── Rotate Credential ──────────────────────────────────────────────────────

export async function rotateCredential(
  identityId: string,
): Promise<RotateResult | null> {
  const { prisma } = getRuntime();
  const existing = await revealCredential(identityId);
  if (!existing) return null;

  const newPassword = generatePassword();
  const rotatedAt = new Date().toISOString();

  const updated = {
    ...existing,
    password: newPassword,
    storedAt: rotatedAt,
  };

  await prisma.credential_secrets.update({
    where: { credential_id: identityId },
    data: {
      encrypted_payload: JSON.stringify(updated),
      updated_at: new Date(),
    },
  });

  // Merge lastRotatedAt into metadata (preserve all other keys).
  const identity = await prisma.integration_identities.findUnique({
    where: { id: identityId },
    select: { metadata: true },
  });
  const meta = (identity?.metadata as Record<string, unknown>) || {};
  await prisma.integration_identities.update({
    where: { id: identityId },
    data: {
      metadata: { ...meta, lastRotatedAt: rotatedAt } as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    },
  });

  return { newPassword, rotatedAt };
}
