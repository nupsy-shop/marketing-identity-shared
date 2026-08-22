/**
 * audit_archive_snapshot — daily redundancy export.
 *
 * Dumps the last 24h of STH + meta-STH rows to MinIO as NDJSON. Provides
 * an extra durability tier: even if the audit_sth tables are wiped,
 * STH integrity records persist in the WORM bucket.
 */
import { getRuntime } from '../runtime.js';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { makeObjectStoreClient } from '../storage/object-store.js';

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  // Prisma 7 returns binary columns as Uint8Array (or Buffer); cover both.
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}

export async function runArchiveSnapshot(): Promise<void> {
  const Bucket = process.env.AUDIT_BUCKET;
  if (!Bucket) throw new Error('[audit] AUDIT_BUCKET not set');
  const { prisma } = getRuntime();
  if (!prisma) throw new Error('[audit] runtime.prisma not registered');
  const client = makeObjectStoreClient();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sths = await prisma.auditSth.findMany({ where: { signedAt: { gte: since } } });
  const metaSths = await prisma.auditMetaSth.findMany({ where: { signedAt: { gte: since } } });

  const today = ymd(new Date());
  const sthBody = sths.map((r: unknown) => JSON.stringify(r, bigintReplacer)).join('\n');
  const metaBody = metaSths.map((r: unknown) => JSON.stringify(r, bigintReplacer)).join('\n');

  const sevenYears = new Date();
  sevenYears.setFullYear(sevenYears.getFullYear() + 7);

  await client.send(new PutObjectCommand({
    Bucket, Key: `audit/snapshots/sth-${today}.ndjson`,
    Body: sthBody, ContentType: 'application/x-ndjson',
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: sevenYears,
  }));
  await client.send(new PutObjectCommand({
    Bucket, Key: `audit/snapshots/meta-sth-${today}.ndjson`,
    Body: metaBody, ContentType: 'application/x-ndjson',
    ObjectLockMode: 'COMPLIANCE', ObjectLockRetainUntilDate: sevenYears,
  }));
}
