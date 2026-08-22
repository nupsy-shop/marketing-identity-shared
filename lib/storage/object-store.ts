/**
 * Object-store client factory — the MinIO→S3 seam for the AWS migration.
 *
 * Provider selection:
 *   1. OBJECT_STORE_PROVIDER=minio|aws — explicit override.
 *   2. Otherwise inferred: STACKHERO_MINIO_HOST set → 'minio' (Heroku/local
 *      today, zero config change), else → 'aws' (ECS task-role credentials
 *      via the SDK default chain; no endpoint, no path-style, no static keys).
 *
 * Every S3-compatible consumer in shared/ builds its client through this
 * factory so cutover is entirely an environment change.
 */
import { S3Client } from '@aws-sdk/client-s3';

export type ObjectStoreProvider = 'minio' | 'aws';

export function resolveObjectStoreProvider(): ObjectStoreProvider {
  const explicit = process.env.OBJECT_STORE_PROVIDER;
  if (explicit === 'minio' || explicit === 'aws') return explicit;
  if (explicit) {
    throw new Error(
      `[storage] invalid OBJECT_STORE_PROVIDER "${explicit}" (expected "minio" or "aws")`,
    );
  }
  return process.env.STACKHERO_MINIO_HOST ? 'minio' : 'aws';
}

export function makeObjectStoreClient(): S3Client {
  if (resolveObjectStoreProvider() === 'minio') {
    const host = process.env.STACKHERO_MINIO_HOST;
    const accessKeyId = process.env.STACKHERO_MINIO_ROOT_ACCESS_KEY;
    const secretAccessKey = process.env.STACKHERO_MINIO_ROOT_SECRET_KEY;
    if (!host || !accessKeyId || !secretAccessKey) {
      throw new Error(
        '[storage] MinIO config missing: set STACKHERO_MINIO_HOST, STACKHERO_MINIO_ROOT_ACCESS_KEY, STACKHERO_MINIO_ROOT_SECRET_KEY',
      );
    }
    return new S3Client({
      endpoint: `https://${host}`,
      region: 'us-east-1', // MinIO ignores region; required by SDK
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
  }
  // AWS: default credential chain (ECS task role / env / profile).
  return new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
}
