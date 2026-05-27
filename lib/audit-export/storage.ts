/**
 * Audit export storage — MinIO PUT + 7-day presigned-URL helper.
 *
 * Bodies are written to the agency's audit bucket under
 *   audit-exports/{agencyId}/{scheduleId}/{ISO}.{ext}
 * No Object Lock — these are convenience extracts, not the WORM canonical
 * audit body. Lifecycle expiration (7 days) is enforced by a bucket-level
 * policy operated outside this code path; the presigned URL we return is
 * scoped to a matching 7-day TTL so both sides agree on the cutoff.
 *
 * SDK loaded via dynamic import so build-time / typecheck environments
 * without `@aws-sdk/client-s3` installed don't fail.
 */

import { getRuntime } from '../runtime.js';

export interface UploadExportArgs {
  agencyId: string;
  scheduleId: string;
  isoTimestamp: string;
  extension: 'csv' | 'json' | 'ndjson';
  contentType: string;
  bytes: Buffer;
}

export interface UploadResult {
  key: string;
  presignedUrl: string;
  sizeBytes: number;
}

export function exportKey(args: { agencyId: string; scheduleId: string; isoTimestamp: string; extension: string }): string {
  return `audit-exports/${args.agencyId}/${args.scheduleId}/${args.isoTimestamp}.${args.extension}`;
}

const PRESIGN_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export async function uploadExport(args: UploadExportArgs): Promise<UploadResult> {
  const { logger } = getRuntime();
  const host = process.env.STACKHERO_MINIO_HOST;
  const accessKeyId = process.env.STACKHERO_MINIO_ROOT_ACCESS_KEY;
  const secretAccessKey = process.env.STACKHERO_MINIO_ROOT_SECRET_KEY;
  const Bucket = process.env.AUDIT_BUCKET;

  const Key = exportKey(args);

  if (!host || !accessKeyId || !secretAccessKey || !Bucket) {
    logger.warn('[audit-export] MinIO config missing — returning unsigned reference (non-production fallback)', {
      agencyId: args.agencyId,
      scheduleId: args.scheduleId,
      key: Key,
    });
    return {
      key: Key,
      presignedUrl: `s3://${Bucket ?? 'audit-bucket'}/${Key}`,
      sizeBytes: args.bytes.length,
    };
  }

  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const client = new S3Client({
    endpoint: `https://${host}`,
    region: 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  await client.send(new PutObjectCommand({
    Bucket,
    Key,
    Body: args.bytes,
    ContentType: args.contentType,
  }));

  const presignedUrl = await getSignedUrl(
    client,
    new GetObjectCommand({ Bucket, Key }),
    { expiresIn: PRESIGN_TTL_SECONDS },
  );

  return { key: Key, presignedUrl, sizeBytes: args.bytes.length };
}
