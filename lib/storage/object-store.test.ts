import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveObjectStoreProvider, makeObjectStoreClient } from './object-store.js';

const ENV_KEYS = [
  'OBJECT_STORE_PROVIDER',
  'STACKHERO_MINIO_HOST',
  'STACKHERO_MINIO_ROOT_ACCESS_KEY',
  'STACKHERO_MINIO_ROOT_SECRET_KEY',
  'AWS_REGION',
];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveObjectStoreProvider', () => {
  it('honors explicit OBJECT_STORE_PROVIDER', () => {
    process.env.OBJECT_STORE_PROVIDER = 'aws';
    process.env.STACKHERO_MINIO_HOST = 'minio.example.com'; // explicit wins over inference
    expect(resolveObjectStoreProvider()).toBe('aws');
  });

  it('rejects unknown values', () => {
    process.env.OBJECT_STORE_PROVIDER = 'gcs';
    expect(() => resolveObjectStoreProvider()).toThrow(/OBJECT_STORE_PROVIDER/);
  });

  it('infers minio when STACKHERO_MINIO_HOST is set (Heroku unchanged)', () => {
    process.env.STACKHERO_MINIO_HOST = 'minio.example.com';
    expect(resolveObjectStoreProvider()).toBe('minio');
  });

  it('infers aws otherwise', () => {
    expect(resolveObjectStoreProvider()).toBe('aws');
  });
});

describe('makeObjectStoreClient', () => {
  it('minio mode: endpoint + path style + static creds', async () => {
    process.env.STACKHERO_MINIO_HOST = 'minio.example.com';
    process.env.STACKHERO_MINIO_ROOT_ACCESS_KEY = 'ak';
    process.env.STACKHERO_MINIO_ROOT_SECRET_KEY = 'sk';
    const c = makeObjectStoreClient();
    expect(await c.config.endpoint!()).toMatchObject({ hostname: 'minio.example.com' });
    expect(c.config.forcePathStyle).toBe(true);
  });

  it('minio mode: throws when creds are missing', () => {
    process.env.STACKHERO_MINIO_HOST = 'minio.example.com';
    expect(() => makeObjectStoreClient()).toThrow(/MinIO config missing/);
  });

  it('aws mode: no custom endpoint, region from AWS_REGION', async () => {
    process.env.AWS_REGION = 'us-east-1';
    const c = makeObjectStoreClient();
    expect(c.config.endpoint).toBeUndefined();
    expect(await c.config.region()).toBe('us-east-1');
  });
});
