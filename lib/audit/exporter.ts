/**
 * audit_export — Bull job handler.
 *
 * Builds a tar.gz bundle containing:
 *   events.jsonl        — one event per line (full body fetched from MinIO)
 *   proofs.json         — { [eventId]: InclusionProof }
 *   sth.json            — latest tenant STH at export time
 *   meta-sth.json       — latest meta-STH at export time
 *   signing-keys.json   — every active + historical signing key
 *   verifier-cli        — copy of the CLI binary (Plan C, Task 8/9)
 *   README.md           — instructions
 *
 * Bundle PUT to MinIO at audit/exports/<jobId>.tar.gz with Object Lock
 * (24-hour retention — bundles are ephemeral; user re-requests if expired).
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getRuntime } from '../runtime.js';
import { buildInclusionProof } from './proof.js';
import { listPublicKeys } from './keys.js';
import { getAuditBody } from './minio-archive.js';
import { makeObjectStoreClient } from '../storage/object-store.js';

function bigintReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  // Prisma 7 returns binary columns as Uint8Array (or Buffer); cover both.
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

export async function runExportJob(jobId: string): Promise<void> {
  const { create: createTar } = await import('tar');
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  const job = await prisma.auditExportJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error(`export job ${jobId} not found`);
  await prisma.auditExportJob.update({ where: { id: jobId }, data: { status: 'building' } });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `audit-export-${jobId}-`));
  try {
    const { agencyId, fromTimestamp, toTimestamp } = job;
    const where: Record<string, unknown> = { agencyId };
    if (fromTimestamp || toTimestamp) {
      const ts: Record<string, Date> = {};
      if (fromTimestamp) ts.gte = fromTimestamp;
      if (toTimestamp)   ts.lte = toTimestamp;
      where.timestamp = ts;
    }
    const events = await prisma.auditEvent.findMany({
      where,
      orderBy: { seq: 'asc' },
    });

    // events.jsonl — fetch each body from MinIO, emit one line per event.
    const eventsPath = path.join(tmpDir, 'events.jsonl');
    const eventsHandle = await fs.open(eventsPath, 'w');
    for (const e of events) {
      const body = await getAuditBody(e.agencyId, e.eventId);
      const wrapped = JSON.stringify({
        seq: e.seq.toString(),
        eventId: e.eventId,
        agencyId: e.agencyId,
        timestamp: e.timestamp.toISOString(),
        prevHash: e.prevHash,
        eventHash: e.eventHash,
        bodySha256: e.bodySha256,
        bodyS3Key: e.bodyS3Key,
        body: JSON.parse(body.toString('utf8')),
      });
      await eventsHandle.write(wrapped + '\n');
    }
    await eventsHandle.close();

    // proofs.json
    const proofs: Record<string, unknown> = {};
    for (const e of events) {
      proofs[e.eventId] = await buildInclusionProof({ eventId: e.eventId, agencyId: e.agencyId });
    }
    await fs.writeFile(path.join(tmpDir, 'proofs.json'), JSON.stringify(proofs, bigintReplacer, 2));

    // sth.json + meta-sth.json
    const sth = await prisma.auditSth.findFirst({ where: { agencyId }, orderBy: { treeSize: 'desc' } });
    const metaSth = await prisma.auditMetaSth.findFirst({ orderBy: { metaSize: 'desc' } });
    await fs.writeFile(path.join(tmpDir, 'sth.json'), JSON.stringify(sth, bigintReplacer, 2));
    await fs.writeFile(path.join(tmpDir, 'meta-sth.json'), JSON.stringify(metaSth, bigintReplacer, 2));

    // signing-keys.json
    await fs.writeFile(path.join(tmpDir, 'signing-keys.json'), JSON.stringify(listPublicKeys(), null, 2));

    // README.md
    await fs.writeFile(path.join(tmpDir, 'README.md'), [
      '# Audit Log Export',
      '',
      'To verify integrity:',
      '',
      '    ./verifier-cli verify .',
      '',
      'Files:',
      '- events.jsonl — your audit events with chain hashes',
      '- proofs.json — RFC 6962 inclusion proofs for each event',
      '- sth.json / meta-sth.json — signed tree heads at export time',
      '- signing-keys.json — public keys used to sign STHs',
      '- verifier-cli — standalone Node binary that runs all checks',
      '',
      'Spec: https://www.rfc-editor.org/rfc/rfc6962',
    ].join('\n'));

    // verifier-cli — copied at deploy time to /opt/verifier-cli; bundle a symlink or copy.
    const cliSrc = process.env.VERIFIER_CLI_PATH ?? '/opt/verifier-cli';
    try {
      await fs.copyFile(cliSrc, path.join(tmpDir, 'verifier-cli'));
      await fs.chmod(path.join(tmpDir, 'verifier-cli'), 0o755);
    } catch {
      await fs.writeFile(
        path.join(tmpDir, 'verifier-cli.NOT-INCLUDED.txt'),
        'Download verifier-cli from /api/audit/verifier-cli',
      );
    }

    // Tar.gz the directory.
    const tarballPath = path.join(tmpDir, '..', `${jobId}.tar.gz`);
    const filesToInclude: string[] = [];
    for (const f of ['events.jsonl', 'proofs.json', 'sth.json', 'meta-sth.json', 'signing-keys.json', 'README.md', 'verifier-cli', 'verifier-cli.NOT-INCLUDED.txt']) {
      try {
        await fs.access(path.join(tmpDir, f));
        filesToInclude.push(f);
      } catch { /* skip missing */ }
    }
    await createTar({ gzip: true, cwd: tmpDir, file: tarballPath }, filesToInclude);

    // PUT to MinIO with 24h retention (bundles expire — re-request if needed).
    const Bucket = process.env.AUDIT_BUCKET!;
    const Key = `audit/exports/${jobId}.tar.gz`;
    const tarballBytes = await fs.readFile(tarballPath);
    const retainUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await makeObjectStoreClient().send(new PutObjectCommand({
      Bucket, Key, Body: tarballBytes, ContentType: 'application/gzip',
      ObjectLockMode: 'GOVERNANCE',
      ObjectLockRetainUntilDate: retainUntil,
    }));

    await prisma.auditExportJob.update({
      where: { id: jobId },
      data: { status: 'ready', bundleS3Key: Key, bundleBytes: BigInt(tarballBytes.length) },
    });
  } catch (err) {
    await prisma.auditExportJob.update({
      where: { id: jobId },
      data: { status: 'failed', error: ((err as Error).message ?? '').slice(0, 1024) },
    });
    throw err;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
