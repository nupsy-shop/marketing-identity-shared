/**
 * audit_seal — every-5-min worker.
 *
 * For each agency with new leaves since its last STH:
 *   1. Fetch all bodySha256 in (seq=1..treeSize), build leaf hashes,
 *      compute RFC 6962 root.
 *   2. Sign (agencyId, treeSize, rootHash, signedAt) with the current
 *      Ed25519 key.
 *   3. INSERT audit_sth row.
 *
 * Then build the meta-tree from the latest tenant root for every agency
 * that has ever sealed:
 *   4. Sort by agencyId; compute meta-leaf = SHA-256(canonicalize({...})).
 *   5. Compute RFC 6962 meta-root.
 *   6. Sign and INSERT audit_meta_sth.
 *   7. INSERT audit_meta_leaves (one per tenant in this meta-tree).
 *   8. POST meta_root to TSA; UPDATE audit_meta_sth.tsa_token / tsa_authority.
 *      On TSA failure, enqueue audit_tsa_retry for the metaSize.
 *
 * Idempotency: tenant STH PK (agencyId, treeSize) and meta STH PK metaSize
 * make duplicate seals collide harmlessly.
 */
import prisma from '@/lib/db/prisma';
import { enqueue } from '@/lib/jobs/enqueue';
import { rfc6962LeafHash, rfc6962MerkleRoot } from './merkle.js';
import { tenantSthMessage, metaSthMessage } from './sth-message.js';
import { signWithCurrentKey, getCurrentKeyId } from './keys.js';
import { canonicalizeBody, sha256Hex } from './canonicalize.js';
import { requestTimestampToken } from './tsa-client.js';

export async function runSealCycle(): Promise<void> {
  // $queryRaw exception: the "find tenants with new leaves" semantics
  // require a LEFT-anti-join correlated subquery across audit_events
  // and audit_sth that can't be expressed cleanly in Prisma's relation
  // model (audit_sth is per-(agencyId, treeSize), not 1-1 with audit_events).
  // Audited and approved per #703 design doc.
  const tenantsToSeal = await prisma.$queryRaw<{ agencyId: string; treeSize: bigint }[]>`
    SELECT e.agency_id AS "agencyId", MAX(e.seq) AS "treeSize"
    FROM   audit_events e
    LEFT JOIN audit_sth s
      ON s.agency_id = e.agency_id
     AND s.tree_size = (SELECT MAX(tree_size) FROM audit_sth WHERE agency_id = e.agency_id)
    WHERE e.seq > COALESCE(s.tree_size, 0)
    GROUP BY e.agency_id
  `;
  if (tenantsToSeal.length === 0) return;

  const keyId = getCurrentKeyId();

  // 2-3. Per-tenant Merkle tree → STH.
  for (const { agencyId, treeSize } of tenantsToSeal) {
    const events = await prisma.auditEvent.findMany({
      where: { agencyId, seq: { lte: treeSize } },
      orderBy: { seq: 'asc' },
      select: { bodySha256: true },
    });
    const leaves = events.map((e: { bodySha256: string }) =>
      rfc6962LeafHash(Buffer.from(e.bodySha256, 'hex')),
    );
    const rootBuf = rfc6962MerkleRoot(leaves);
    const rootHash = rootBuf.toString('hex');
    const signedAt = new Date();
    const signature = signWithCurrentKey(
      tenantSthMessage({ agencyId, treeSize, rootHash, signedAt }),
    );
    try {
      await prisma.auditSth.create({
        data: { agencyId, treeSize, rootHash, signedAt, signature, keyId },
      });
    } catch (err) {
      // Duplicate (agencyId, treeSize) — another sealer beat us. Idempotent skip.
      if ((err as { code?: string }).code === 'P2002') continue;
      throw err;
    }
  }

  // 4-5. Build meta-tree from latest tenant root per agency.
  const tenantHeads = await prisma.auditSth.findMany({
    distinct: ['agencyId'],
    orderBy: [{ agencyId: 'asc' }, { treeSize: 'desc' }],
    select: { agencyId: true, treeSize: true, rootHash: true },
  });
  // distinct() in Prisma keeps the FIRST per group with the given orderBy;
  // since we order treeSize desc, that's the largest. Sort once more by
  // agencyId for deterministic meta-leaf order.
  const sortedHeads = [...tenantHeads].sort((a, b) =>
    a.agencyId.localeCompare(b.agencyId),
  );

  const metaLeafBuffers = sortedHeads.map(
    (h: { agencyId: string; treeSize: bigint; rootHash: string }) => {
      const leafContent = canonicalizeBody({
        agencyId: h.agencyId,
        treeSize: h.treeSize.toString(),
        rootHash: h.rootHash,
      });
      return rfc6962LeafHash(
        Buffer.from(sha256Hex(Buffer.from(leafContent, 'utf8')), 'hex'),
      );
    },
  );
  const metaRootBuf = rfc6962MerkleRoot(metaLeafBuffers);
  const metaRoot = metaRootBuf.toString('hex');
  const metaSize = BigInt(sortedHeads.length);
  const metaSignedAt = new Date();
  const metaSignature = signWithCurrentKey(
    metaSthMessage({ metaSize, metaRoot, signedAt: metaSignedAt }),
  );

  // 6-7. Persist meta-STH and leaves.
  try {
    await prisma.auditMetaSth.create({
      data: {
        metaSize,
        metaRoot,
        signedAt: metaSignedAt,
        signature: metaSignature,
        keyId,
      },
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'P2002') return; // someone sealed at this metaSize already
    throw err;
  }
  await prisma.auditMetaLeaf.createMany({
    data: sortedHeads.map(
      (h: { agencyId: string; treeSize: bigint; rootHash: string }, idx: number) => ({
        metaSize,
        agencyId: h.agencyId,
        treeSize: h.treeSize,
        rootHash: h.rootHash,
        leafIndex: BigInt(idx),
      }),
    ),
  });

  // 8. TSA anchor (best-effort).
  const tsaUrl = process.env.TSA_URL ?? 'https://freetsa.org/tsr';
  const tsaAuthority = process.env.TSA_AUTHORITY ?? 'freetsa.org';
  try {
    const token = await requestTimestampToken({ tsaUrl, sha256Digest: metaRootBuf });
    await prisma.auditMetaSth.update({
      where: { metaSize },
      data: { tsaToken: token, tsaAuthority },
    });
  } catch (err) {
    console.warn(
      `[audit-seal] TSA anchor failed for metaSize=${metaSize}: ${(err as Error).message}`,
    );
    await enqueue('audit_tsa_retry', { metaSize: metaSize.toString() }).catch(() => {});
  }
}

// TSA retry handler (registered as a separate Bull handler).
export async function handleTsaRetry(payload: { metaSize: string }): Promise<void> {
  const metaSize = BigInt(payload.metaSize);
  const row = await (prisma as any).auditMetaSth.findUnique({ where: { metaSize } });
  if (!row) return;
  if (row.tsaToken) return; // already anchored
  const tsaUrl = process.env.TSA_URL ?? 'https://freetsa.org/tsr';
  const tsaAuthority = process.env.TSA_AUTHORITY ?? 'freetsa.org';
  const token = await requestTimestampToken({
    tsaUrl,
    sha256Digest: Buffer.from(row.metaRoot, 'hex'),
  });
  await prisma.auditMetaSth.update({
    where: { metaSize },
    data: { tsaToken: token, tsaAuthority },
  });
}
