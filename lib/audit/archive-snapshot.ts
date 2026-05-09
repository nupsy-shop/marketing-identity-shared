/**
 * audit_archive_snapshot — daily redundancy export.
 *
 * Dumps the last 24h of STH + meta-STH rows to MinIO as NDJSON. Provides
 * an extra durability tier: even if the audit_sth tables are wiped,
 * STH integrity records persist in the WORM bucket.
 */
import prisma from '@/lib/db/prisma';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

function getClient(): S3Client {
  const host = process.env.STACKHERO_MINIO_HOST!;
  const accessKeyId = process.env.STACKHERO_MINIO_ROOT_ACCESS_KEY!;
  const secretAccessKey = process.env.STACKHERO_MINIO_ROOT_SECRET_KEY!;
  return new S3Client({
    endpoint: `https://${host}`,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function bigintReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

export async function runArchiveSnapshot(): Promise<void> {
  const Bucket = process.env.AUDIT_BUCKET;
  if (!Bucket) throw new Error('[audit] AUDIT_BUCKET not set');
  const client = getClient();

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sths = await prisma.auditSth.findMany({ where: { signedAt: { gte: since } } });
  const metaSths = await prisma.auditMetaSth.findMany({ where: { signedAt: { gte: since } } });

  const today = ymd(new Date());
  const sthBody = sths.map(r => JSON.stringify(r, bigintReplacer)).join('\n');
  const metaBody = metaSths.map(r => JSON.stringify(r, bigintReplacer)).join('\n');

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
