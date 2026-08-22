/**
 * S3 uploader for trust reports (shared port of #57).
 *
 * Uploads the PDF bytes to the trust-reports bucket and returns a 7-day
 * presigned URL. The notification dispatch carries this URL to subscribed
 * client contacts; the raw PDF bytes are NEVER placed in the audit or
 * dispatch payload.
 *
 * Bucket + credentials, by environment:
 *   - Heroku: the `bucketeer` addon on `marketing-identity-bull` and
 *     `marketing-identity` sets BUCKETEER_AWS_ACCESS_KEY_ID /
 *     BUCKETEER_AWS_SECRET_ACCESS_KEY / BUCKETEER_AWS_REGION /
 *     BUCKETEER_BUCKET_NAME — static keys against a Heroku-managed bucket.
 *   - AWS (ECS): no Bucketeer addon. TRUST_REPORTS_BUCKET names the bucket
 *     directly and the ECS task role supplies credentials via the SDK
 *     default chain (see lib/storage/object-store.ts for the analogous
 *     MinIO→AWS seam used elsewhere in shared/).
 *
 * The AWS SDK is loaded via dynamic import so build-time environments
 * (web `yarn build`, worker `tsc --noEmit`) do not need the SDK
 * installed to typecheck. Callers that actually invoke this function
 * must have `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
 * available at runtime.
 */

export interface StoreReportArgs {
  agency: { id: string; slug: string | null };
  client: { id: string };
  quarter: { startDate: string };
  bytes: Uint8Array;
}

/**
 * Bucketeer (Heroku addon): static keys. On AWS: task-role default chain.
 * Dynamic import (like the rest of this module) so typecheck / build
 * doesn't require the SDK.
 */
async function makeTrustReportsClient() {
  const { S3Client } = await import('@aws-sdk/client-s3');
  if (process.env.BUCKETEER_AWS_ACCESS_KEY_ID && process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY) {
    return new S3Client({
      region: process.env.BUCKETEER_AWS_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.BUCKETEER_AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.BUCKETEER_AWS_SECRET_ACCESS_KEY,
      },
    });
  }
  return new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
}

export async function storeReport(args: StoreReportArgs): Promise<string> {
  const { agency, client, quarter, bytes } = args;

  const bucket = process.env.TRUST_REPORTS_BUCKET ?? process.env.BUCKETEER_BUCKET_NAME;
  const key = `trust-reports/${agency.id}/${client.id}/${quarter.startDate}.pdf`;

  if (!bucket) {
    throw new Error(
      '[trust-reports] bucket config missing: set TRUST_REPORTS_BUCKET (AWS) or BUCKETEER_BUCKET_NAME (Heroku)',
    );
  }

  // Dynamic import so typecheck / build doesn't require the SDK.
  const { PutObjectCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');

  const s3 = await makeTrustReportsClient();

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
