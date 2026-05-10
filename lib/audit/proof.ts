/**
 * Inclusion proof builder. Used by:
 *   - GET /api/audit/events/:eventId/proof
 *   - The export job (per-event proofs.json entries)
 *
 * Output shape matches the verifier CLI's expected input. Bigints are
 * rendered as decimal strings; bytes as base64.
 */
import prisma from '@/lib/db/prisma';
import { rfc6962LeafHash, rfc6962MerkleRoot, rfc6962AuditPath } from './merkle.js';
import { canonicalizeBody, sha256Hex } from './canonicalize.js';

export interface InclusionProof {
  eventId: string;
  agencyId: string;
  seq: string;                   // bigint as decimal string
  bodySha256: string;
  leafHash: string;              // hex of rfc6962LeafHash(bodySha256 bytes)
  tenantSth: {
    treeSize: string;
    rootHash: string;
    signedAt: string;            // ISO 8601
    signature: string;           // base64
    keyId: string;
  };
  tenantAuditPath: string[];     // hex sibling hashes
  metaInclusion: {
    metaSize: string;
    metaRoot: string;
    metaSignedAt: string;
    metaSignature: string;
    metaKeyId: string;
    leafIndex: string;
    metaAuditPath: string[];
    tsaToken: string | null;     // base64
    tsaAuthority: string | null;
  };
}

export interface BuildInclusionProofArgs {
  eventId: string;
  agencyId: string;
}

export async function buildInclusionProof(args: BuildInclusionProofArgs): Promise<InclusionProof> {
  const event = await prisma.auditEvent.findUnique({ where: { eventId: args.eventId } });
  if (!event || event.agencyId !== args.agencyId) {
    throw new Error(`event ${args.eventId} not found in agency ${args.agencyId}`);
  }

  // Find an STH that includes this event (smallest tree_size >= seq).
  const sth = await prisma.auditSth.findFirst({
    where: { agencyId: args.agencyId, treeSize: { gte: event.seq } },
    orderBy: { treeSize: 'asc' },
  });
  if (!sth) {
    throw new Error(`event ${args.eventId} not yet included in any STH (next seal in <5 min)`);
  }

  // Re-fetch all bodySha256 in (1..treeSize) to recompute leaf hashes for path.
  const allLeaves = await prisma.auditEvent.findMany({
    where: { agencyId: args.agencyId, seq: { lte: sth.treeSize } },
    orderBy: { seq: 'asc' },
    select: { bodySha256: true },
  });
  const leaves = allLeaves.map(e => rfc6962LeafHash(Buffer.from(e.bodySha256, 'hex')));
  const leafIdx = Number(event.seq) - 1; // seq is 1-based, leaf array is 0-based
  const auditPath = rfc6962AuditPath(leaves, leafIdx).map(b => b.toString('hex'));

  const leafHash = leaves[leafIdx].toString('hex');

  // Find a meta-STH that includes this tenant's STH.
  const metaLeaf = await prisma.auditMetaLeaf.findFirst({
    where: { agencyId: args.agencyId, treeSize: { gte: sth.treeSize } },
    orderBy: [{ treeSize: 'asc' }, { metaSize: 'asc' }],
  });
  if (!metaLeaf) {
    throw new Error(`tenant STH not yet included in any meta-STH`);
  }
  const metaSth = await prisma.auditMetaSth.findFirst({ where: { metaSize: metaLeaf.metaSize } });
  if (!metaSth) throw new Error(`meta-STH ${metaLeaf.metaSize} missing`);

  // Reconstruct meta-leaves at this metaSize to compute path.
  const allMetaLeaves = await prisma.auditMetaLeaf.findMany({
    where: { metaSize: metaLeaf.metaSize },
    orderBy: { leafIndex: 'asc' },
    select: { agencyId: true, treeSize: true, rootHash: true, leafIndex: true },
  });
  const metaLeafBuffers = allMetaLeaves.map(l => {
    const content = canonicalizeBody({
      agencyId: l.agencyId,
      treeSize: l.treeSize.toString(),
      rootHash: l.rootHash,
    });
    return rfc6962LeafHash(Buffer.from(sha256Hex(Buffer.from(content, 'utf8')), 'hex'));
  });
  const metaPath = rfc6962AuditPath(metaLeafBuffers, Number(metaLeaf.leafIndex))
    .map(b => b.toString('hex'));

  return {
    eventId: event.eventId,
    agencyId: event.agencyId,
    seq: event.seq.toString(),
    bodySha256: event.bodySha256,
    leafHash,
    tenantSth: {
      treeSize: sth.treeSize.toString(),
      rootHash: sth.rootHash,
      signedAt: sth.signedAt.toISOString(),
      signature: Buffer.from(sth.signature).toString('base64'),
      keyId: sth.keyId,
    },
    tenantAuditPath: auditPath,
    metaInclusion: {
      metaSize: metaSth.metaSize.toString(),
      metaRoot: metaSth.metaRoot,
      metaSignedAt: metaSth.signedAt.toISOString(),
      metaSignature: Buffer.from(metaSth.signature).toString('base64'),
      metaKeyId: metaSth.keyId,
      leafIndex: metaLeaf.leafIndex.toString(),
      metaAuditPath: metaPath,
      tsaToken: metaSth.tsaToken ? Buffer.from(metaSth.tsaToken).toString('base64') : null,
      tsaAuthority: metaSth.tsaAuthority,
    },
  };
}
