/**
 * MinIO (S3-compatible) archive client for audit event bodies.
 *
 * Bodies are written once at publish time with Object Lock Compliance + 7-year
 * retention. Object Lock makes the body immutable to all roles (including
 * platform admin) for the retention window — this is the core WORM guarantee
 * that backs the "tamper-evident" claim.
 *
 * Endpoint: Stackhero MinIO addon. Provides S3-compatible API; we use the
 * AWS SDK's S3 client pointed at the Stackhero endpoint.
 */
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

let _client: S3Client | null = null;

function getClient(): S3Client {
  if (_client) return _client;
  const host = process.env.STACKHERO_MINIO_HOST;
  const accessKeyId = process.env.STACKHERO_MINIO_ROOT_ACCESS_KEY;
  const secretAccessKey = process.env.STACKHERO_MINIO_ROOT_SECRET_KEY;
  if (!host || !accessKeyId || !secretAccessKey) {
    throw new Error(
      '[audit] MinIO config missing: set STACKHERO_MINIO_HOST, STACKHERO_MINIO_ROOT_ACCESS_KEY, STACKHERO_MINIO_ROOT_SECRET_KEY',
    );
  }
  _client = new S3Client({
    endpoint: `https://${host}`,
    region: 'us-east-1', // MinIO ignores region; required by SDK
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return _client;
}

export function auditBodyKey(agencyId: string, eventId: string): string {
  return `audit/${agencyId}/${eventId}.json`;
}

const RETENTION_YEARS = 7;
function retainUntil(now: Date): Date {
  const r = new Date(now);
  r.setFullYear(r.getFullYear() + RETENTION_YEARS);
  return r;
}

export interface PutAuditBodyArgs {
  agencyId: string;
  eventId: string;
  body: Buffer;
}

export async function putAuditBody(args: PutAuditBodyArgs): Promise<void> {
  const Bucket = process.env.AUDIT_BUCKET;
  if (!Bucket) throw new Error('[audit] AUDIT_BUCKET env var not set');
  const Key = auditBodyKey(args.agencyId, args.eventId);
  await getClient().send(new PutObjectCommand({
    Bucket,
    Key,
    Body: args.body,
    ContentType: 'application/json',
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntil(new Date()),
  }));
}

/**
 * Read body for a single event (used by ES-indexer worker and by the
 * inclusion-proof endpoint in Plan C). Failures bubble up to the caller.
 */
export async function getAuditBody(agencyId: string, eventId: string): Promise<Buffer> {
  const Bucket = process.env.AUDIT_BUCKET;
  if (!Bucket) throw new Error('[audit] AUDIT_BUCKET env var not set');
  const Key = auditBodyKey(agencyId, eventId);
  const out = await getClient().send(new GetObjectCommand({ Bucket, Key }));
  const stream = out.Body as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

// Test seam.
export function __resetClientForTest(): void { _client = null; }
