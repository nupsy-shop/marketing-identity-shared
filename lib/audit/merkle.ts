/**
 * RFC 6962 Merkle tree (Certificate Transparency).
 *
 * Used by the audit sealer to compute tenant + meta tree roots and audit
 * paths. The customer-facing verifier (Plan C) re-uses this exact module
 * (or a JS port of the same algorithm) to reconstruct roots from proofs.
 *
 * Algorithm:
 *   leafHash(d)        = SHA256(0x00 || d)
 *   internalHash(l, r) = SHA256(0x01 || l || r)
 *   root([])           = SHA256("") (32 zero bytes per the spec convention)
 *   root([h])          = h
 *   root(leaves)       = internalHash(root(left half), root(right half))
 *                        where the split puts 2^k leaves on the left,
 *                        2^k = largest power of two strictly less than
 *                        |leaves|. (This is the unbalanced split that gives
 *                        consistency-proof support.)
 *
 * All inputs and outputs are 32-byte Buffers.
 */
import crypto from 'crypto';

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

function sha(b: Buffer): Buffer {
  return crypto.createHash('sha256').update(b).digest();
}

export function rfc6962LeafHash(data: Buffer): Buffer {
  return sha(Buffer.concat([LEAF_PREFIX, data]));
}

function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha(Buffer.concat([NODE_PREFIX, left, right]));
}

/** Largest power of two strictly less than n. Assumes n >= 2. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Merkle root over an array of LEAF HASHES (not raw data).
 * Caller is responsible for applying rfc6962LeafHash() per leaf.
 */
export function rfc6962MerkleRoot(leafHashes: Buffer[]): Buffer {
  if (leafHashes.length === 0) return Buffer.alloc(32);
  if (leafHashes.length === 1) return leafHashes[0];
  const k = splitPoint(leafHashes.length);
  const left = rfc6962MerkleRoot(leafHashes.slice(0, k));
  const right = rfc6962MerkleRoot(leafHashes.slice(k));
  return nodeHash(left, right);
}

/**
 * RFC 6962 §2.1.1 inclusion proof / "audit path" for leaf at `index`
 * in a tree of `leafHashes`. Returns the array of sibling hashes from
 * the leaf up to the root.
 */
export function rfc6962AuditPath(leafHashes: Buffer[], index: number): Buffer[] {
  if (index < 0 || index >= leafHashes.length) {
    throw new RangeError(`leaf index ${index} out of range [0, ${leafHashes.length})`);
  }
  return auditPath(leafHashes, index);
}

function auditPath(leaves: Buffer[], m: number): Buffer[] {
  const n = leaves.length;
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) {
    return [...auditPath(leaves.slice(0, k), m), rfc6962MerkleRoot(leaves.slice(k))];
  } else {
    return [...auditPath(leaves.slice(k), m - k), rfc6962MerkleRoot(leaves.slice(0, k))];
  }
}

/**
 * RFC 6962 §2.1.2 consistency proof. Proves that a tree of size m is
 * an append-only extension of a tree of size n (n <= m). Used by Plan C's
 * `GET /api/audit/consistency-proof` endpoint (Phase-2 deferred — but the
 * algorithm is included here so the API can light up later without
 * touching this file).
 */
export function rfc6962ConsistencyProof(leaves: Buffer[], n: number, m: number): Buffer[] {
  if (n < 0 || n > m || m > leaves.length) {
    throw new RangeError(`invalid consistency-proof bounds n=${n} m=${m} len=${leaves.length}`);
  }
  if (n === 0 || n === m) return [];
  return subProof(leaves.slice(0, m), n, true);
}

function subProof(leaves: Buffer[], n: number, isOriginalRoot: boolean): Buffer[] {
  const m = leaves.length;
  if (n === m) {
    return isOriginalRoot ? [] : [rfc6962MerkleRoot(leaves)];
  }
  const k = splitPoint(m);
  if (n <= k) {
    return [...subProof(leaves.slice(0, k), n, isOriginalRoot), rfc6962MerkleRoot(leaves.slice(k))];
  } else {
    return [...subProof(leaves.slice(k), n - k, false), rfc6962MerkleRoot(leaves.slice(0, k))];
  }
}
