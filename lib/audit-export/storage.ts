/**
 * Audit export storage — object-store PUT + 7-day presigned-URL helper.
 *
 * Bodies are written to the agency's audit bucket under
 *   audit-exports/{agencyId}/{scheduleId}/{ISO}.{ext}
 * No Object Lock — these are convenience extracts, not the WORM canonical
 * audit body. Lifecycle expiration (7 days) is enforced by a bucket-level
 * policy operated outside this code path; the presigned URL we return is
 * scoped to a matching 7-day TTL so both sides agree on the cutoff.
 *
 * Client construction (Stackhero MinIO on Heroku, AWS task-role on ECS) is
 * decided by the object-store provider seam — see lib/storage/object-store.ts.
 * `getSignedUrl` is still loaded via dynamic import so build-time /
 * typecheck environments without `@aws-sdk/s3-request-presigner` installed
 * don't fail.
 */

import { getRuntime } from '../runtime.js';
import { makeObjectStoreClient } from '../storage/object-store.js';

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
  const Bucket = process.env.AUDIT_BUCKET;

  const Key = exportKey(args);

  if (!Bucket) {
    logger.warn('[audit-export] AUDIT_BUCKET not set — returning unsigned reference (non-production fallback)', {
      agencyId: args.agencyId,
      scheduleId: args.scheduleId,
      key: Key,
    });
    return {
      key: Key,
      presignedUrl: `s3://audit-bucket/${Key}`,
      sizeBytes: args.bytes.length,
    };
  }

  const { PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const client = makeObjectStoreClient();

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
