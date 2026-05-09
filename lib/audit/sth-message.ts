/**
 * Canonical message bytes for STH/meta-STH signing.
 *
 * Format (concatenation, all big-endian):
 *
 *   tenantSthMessage:
 *     "AS\x01"                       3 bytes magic + version
 *     uint8 agencyId_utf8_len
 *     agencyId UTF-8 bytes           (variable)
 *     uint64 treeSize                8 bytes BE
 *     32 bytes rootHash              (raw, decoded from hex)
 *     uint64 signedAtMs              8 bytes BE
 *
 *   metaSthMessage:
 *     "AM\x01"                       3 bytes magic + version
 *     uint64 metaSize                8 bytes BE
 *     32 bytes metaRoot
 *     uint64 signedAtMs              8 bytes BE
 *
 * The fixed binary format avoids any JSON canonicalization disagreement
 * between server and verifier. Bumping the version byte is how we
 * evolve the format — old verifiers reject newer messages cleanly.
 */
const TENANT_MAGIC = Buffer.from('AS\x01', 'utf8');
const META_MAGIC = Buffer.from('AM\x01', 'utf8');

function uint64BE(n: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(n);
  return buf;
}

function hexToBytes(hex: string): Buffer {
  if (hex.length !== 64) throw new Error(`expected 64-char hex root hash, got ${hex.length}`);
  return Buffer.from(hex, 'hex');
}

export interface TenantSthInput {
  agencyId: string;
  treeSize: bigint;
  rootHash: string;     // 64 hex chars
  signedAt: Date;
}

export function tenantSthMessage(input: TenantSthInput): Buffer {
  const agencyBytes = Buffer.from(input.agencyId, 'utf8');
  if (agencyBytes.length > 255) throw new Error('agencyId too long');
  return Buffer.concat([
    TENANT_MAGIC,
    Buffer.from([agencyBytes.length]),
    agencyBytes,
    uint64BE(input.treeSize),
    hexToBytes(input.rootHash),
    uint64BE(BigInt(input.signedAt.getTime())),
  ]);
}

export interface MetaSthInput {
  metaSize: bigint;
  metaRoot: string;
  signedAt: Date;
}

export function metaSthMessage(input: MetaSthInput): Buffer {
  return Buffer.concat([
    META_MAGIC,
    uint64BE(input.metaSize),
    hexToBytes(input.metaRoot),
    uint64BE(BigInt(input.signedAt.getTime())),
  ]);
}
