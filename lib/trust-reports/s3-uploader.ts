/**
 * Bucketeer-backed S3 uploader for trust reports (shared port of #57).
 *
 * Uploads the PDF bytes to the Heroku-managed Bucketeer bucket and
 * returns a 7-day presigned URL. The notification dispatch carries this
 * URL to subscribed client contacts; the raw PDF bytes are NEVER placed
 * in the audit or dispatch payload.
 *
 * Required env vars (set automatically by the `bucketeer` Heroku addon
 * on `marketing-identity-bull` and `marketing-identity`):
 *   BUCKETEER_AWS_ACCESS_KEY_ID
 *   BUCKETEER_AWS_SECRET_ACCESS_KEY
 *   BUCKETEER_AWS_REGION
 *   BUCKETEER_BUCKET_NAME
 *
 * Falls back to a stable `s3://…` reference string when credentials are
 * absent so local/test runs don't fail — production always has them.
 *
 * The AWS SDK is loaded via dynamic import so build-time environments
 * (web `yarn build`, worker `tsc --noEmit`) do not need the SDK
 * installed to typecheck. Callers that actually invoke this function
 * must have `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
 * available at runtime.
 */

import { getRuntime } from '../runtime.js';

export interface StoreReportArgs {
  agency: { id: string; slug: string | null };
  client: { id: string };
  quarter: { startDate: string };
  bytes: Uint8Array;
}

export async function storeReport(args: StoreReportArgs): Promise<string> {
  const { agency, client, quarter, bytes } = args;
  const { logger } = getRuntime();

  const bucket = process.env.BUCKETEER_BUCKET_NAME;
  const accessKeyId = process.env.BUCKETEER_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY;
  const region = process.env.BUCKETEER_AWS_REGION || 'us-east-1';

  const key = `trust-reports/${agency.id}/${client.id}/${quarter.startDate}.pdf`;

  if (!bucket || !accessKeyId || !secretAccessKey) {
    logger.warn(
      '[trust-reports] Bucketeer creds missing; returning unsigned s3:// reference (non-production fallback)',
      { agencyId: agency.id, clientId: client.id, key },
    );
    return `s3://trust-reports/${agency.id}/${client.id}/${quarter.startDate}.pdf`;
  }

  // Dynamic import so typecheck / build doesn't require the SDK.
  const { S3Client, PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const s3 = new S3Client({
    region,
    credentials: { accessKeyId, secretAccessKey },
  });

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: 'application/pdf',
      // Private by design — clients fetch via the time-limited presigned URL.
      ACL: 'private',
      ServerSideEncryption: 'AES256',
    }),
  );

  // 7-day presigned URL — clients receive the link in the delivery
  // notification and have a week to download before it expires.
  const presigned = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 60 * 60 * 24 * 7 },
  );

  return presigned;
}
