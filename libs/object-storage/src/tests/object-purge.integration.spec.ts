import { Buffer } from 'node:buffer';

import {
  CreateBucketCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ObjectStorageService } from '../lib/object-storage.service.js';
import { S3ClientFactory } from '../lib/s3-client.factory.js';

// S2 Talent Erasure Integrity (Architect ruling F5) — the ERASURE-grade purge on
// a VERSIONED bucket (the platform bucket is versioned). A plain DeleteObject only
// writes a delete-marker and leaves the prior versions (the PII) recoverable;
// purgeObjectAllVersions must remove every version AND delete-marker of the
// exact key, report 0 remaining, never touch a sibling key sharing the prefix,
// and be idempotent.

const BUCKET = 'aramo-test-erasure';
const ENV = ['S3_RESUME_BUCKET', 'AWS_REGION', 'S3_ENDPOINT', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const;

describe.skipIf(process.env['ARAMO_RUN_INTEGRATION'] !== '1')('S2 — purgeObjectAllVersions (LocalStack, versioned bucket)', () => {
  let localstack: StartedLocalStackContainer;
  let admin: S3Client;
  let service: ObjectStorageService;
  const saved: Partial<Record<(typeof ENV)[number], string | undefined>> = {};

  const versionsOf = async (key: string): Promise<number> => {
    const r = await admin.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    return [...(r.Versions ?? []), ...(r.DeleteMarkers ?? [])].filter((v) => v.Key === key).length;
  };

  beforeAll(async () => {
    localstack = await new LocalstackContainer('localstack/localstack:3').start();
    const endpoint = localstack.getConnectionUri();
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      S3_RESUME_BUCKET: BUCKET,
      AWS_REGION: 'us-east-1',
      S3_ENDPOINT: endpoint,
      AWS_ACCESS_KEY_ID: 'test',
      AWS_SECRET_ACCESS_KEY: 'test',
    });
    admin = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    await admin.send(new PutBucketVersioningCommand({ Bucket: BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    service = new ObjectStorageService(new S3ClientFactory(), logger as never);
  }, 180_000);

  afterAll(async () => {
    await localstack?.stop();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('removes every version + delete-marker of the exact key, leaves the sibling, verifies 0 remain, and is idempotent', async () => {
    const key = 't1/talent/r1/resume/u1-Jane_Doe_Resume.pdf';
    const sibling = `${key}.bak`; // shares the prefix — must survive
    for (const body of ['v1', 'v2', 'v3']) {
      await admin.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: Buffer.from(body) }));
    }
    await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })); // a plain delete: only a marker
    await admin.send(new PutObjectCommand({ Bucket: BUCKET, Key: sibling, Body: Buffer.from('keep') }));
    expect(await versionsOf(key)).toBe(4); // 3 versions + 1 delete-marker: the PII is still recoverable

    const r = await service.purgeObjectAllVersions({ storage_key: key, requestId: 'rq' });
    expect(r).toEqual({ deleted: 4, remaining: 0 });
    expect(await versionsOf(key)).toBe(0);
    expect(await versionsOf(sibling)).toBe(1);

    expect(await service.purgeObjectAllVersions({ storage_key: key, requestId: 'rq' })).toEqual({ deleted: 0, remaining: 0 });
  });

  it('a purge against a missing bucket throws (a failed attempt, never success)', async () => {
    process.env['S3_RESUME_BUCKET'] = 'no-such-bucket';
    const broken = new ObjectStorageService(new S3ClientFactory(), { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never);
    await expect(broken.purgeObjectAllVersions({ storage_key: 'k', requestId: 'rq' })).rejects.toMatchObject({ code: 'OBJECT_STORAGE_UPLOAD_FAILED' });
    process.env['S3_RESUME_BUCKET'] = BUCKET;
  });
});
