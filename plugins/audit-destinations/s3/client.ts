/**
 * AWS S3 archive client.
 *
 * Each batch becomes one NDJSON object at:
 *   {prefix}/YYYY/MM/DD/{uuid}.ndjson
 *
 * Compression (gzip) is intentionally deferred to a follow-up — keep this
 * client simple. S3 server-side encryption is enabled (SSE-S3 default) by
 * passing ServerSideEncryption: 'AES256'.
 */

import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import type {
  AuditEvent,
  SendResult,
} from '../common/audit-destination-plugin.interface.js';
import { buildTestEvent } from '../common/test-event.js';

export interface S3Config {
  region: string;
  bucket: string;
  prefix: string;       // e.g. "agency-ag1" or "" for bucket-root
  endpoint?: string;    // optional custom endpoint (S3-compatible stores)
}

export interface S3Auth {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface FormattedS3Batch {
  body: string;         // NDJSON
}

export function formatBatch(events: AuditEvent[], _config: Record<string, unknown>): FormattedS3Batch {
  return { body: events.map((e) => JSON.stringify(e)).join('\n') + '\n' };
}

function buildKey(prefix: string): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const head = prefix ? `${prefix.replace(/\/$/, '')}/` : '';
  return `${head}${yyyy}/${mm}/${dd}/${randomUUID()}.ndjson`;
}

function buildClient(config: S3Config, auth: S3Auth): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: !!config.endpoint,
    credentials: { accessKeyId: auth.accessKeyId, secretAccessKey: auth.secretAccessKey },
  });
}

export async function sendBatch(
  formatted: FormattedS3Batch,
  config: S3Config,
  auth: S3Auth,
  _agencyId: string,
): Promise<SendResult> {
  const start = Date.now();
  try {
    const s3 = buildClient(config, auth);
    await s3.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: buildKey(config.prefix),
        Body: formatted.body,
        ContentType: 'application/x-ndjson',
        ServerSideEncryption: 'AES256',
      }),
    );
    return { success: true, responseTimeMs: Date.now() - start };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      responseTimeMs: Date.now() - start,
    };
  }
}

export async function sendTest(config: S3Config, auth: S3Auth, agencyId: string): Promise<SendResult> {
  const formatted = formatBatch([buildTestEvent(agencyId)], {});
  return sendBatch(formatted, config, auth, agencyId);
}
