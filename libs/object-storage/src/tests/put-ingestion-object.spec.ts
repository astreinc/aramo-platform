import { createHash } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

import { ObjectStorageService } from '../lib/object-storage.service.js';
import type { S3ClientFactory } from '../lib/s3-client.factory.js';

// SRC-1 PR-2 (R13 added specs) — putIngestionObject unit coverage: key shape,
// server-side sha256 correctness, and raw-byte fidelity of the stored object.
// Fast unit test — the S3 client's `send` is mocked to capture the
// PutObjectCommand (no LocalStack); the LocalStack round-trip lives in the
// existing object-storage integration spec.

const TENANT = '00000000-0000-4000-8000-000000000001';
const BUCKET = 'aramo-test-documents';

function buildService(send: ReturnType<typeof vi.fn>): ObjectStorageService {
  const factory = {
    getClient: () => ({ send }),
    getConfig: () => ({
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: null,
      forcePathStyle: false,
    }),
  } as unknown as S3ClientFactory;
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return new ObjectStorageService(
    factory,
    logger as unknown as ConstructorParameters<typeof ObjectStorageService>[1],
  );
}

describe('ObjectStorageService.putIngestionObject', () => {
  it('writes the raw bytes verbatim under the ingestion key convention and returns s3:// ref + hex sha256', async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = buildService(send);
    const body = Buffer.from('{"id":"apply-abc-123","applicant":{"email":"a@b.co"}}', 'utf8');

    const result = await service.putIngestionObject({
      tenant_id: TENANT,
      // uppercase on input → lowercased in the key (R13.2).
      channel: 'INDEED',
      external_source_id: 'apply-abc-123',
      body,
      content_type: 'application/json',
      requestId: 'req-1',
    });

    // One PutObjectCommand sent; capture its input.
    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as { input: Record<string, unknown> };
    const input = command.input;

    // Key shape: {tenant}/ingestion/{channel-lowercased}/{ext}/{uuidv7}.json
    expect(input['Key']).toMatch(
      new RegExp(
        `^${TENANT}/ingestion/indeed/apply-abc-123/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$`,
      ),
    );
    expect(input['Bucket']).toBe(BUCKET);
    expect(input['ContentType']).toBe('application/json');

    // Raw-byte fidelity: the stored Body is byte-identical to the input buffer.
    expect(Buffer.isBuffer(input['Body'])).toBe(true);
    expect(Buffer.compare(input['Body'] as Buffer, body)).toBe(0);

    // Server-side sha256 correctness (hex, 64 lowercase — passes the DTO regex).
    const expectedSha = createHash('sha256').update(body).digest('hex');
    expect(result.sha256).toBe(expectedSha);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    // storage_ref is the s3:// reference the ingestion front door stores.
    expect(result.storage_ref).toBe(`s3://${BUCKET}/${input['Key'] as string}`);
  });

  it('preserves non-UTF8 / binary bytes exactly (raw-byte fidelity)', async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = buildService(send);
    const body = Buffer.from([0x00, 0xff, 0x7b, 0xc3, 0x28, 0x0a, 0xfe]);

    const result = await service.putIngestionObject({
      tenant_id: TENANT,
      channel: 'indeed',
      external_source_id: 'binfid-1',
      body,
      content_type: 'application/octet-stream',
      requestId: 'req-2',
    });

    const input = (send.mock.calls[0][0] as { input: Record<string, unknown> })
      .input;
    expect(Buffer.compare(input['Body'] as Buffer, body)).toBe(0);
    expect(result.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('mints a distinct receipt_uuid per call — redeliveries land as distinct objects', async () => {
    const send = vi.fn().mockResolvedValue({});
    const service = buildService(send);
    const body = Buffer.from('{"id":"apply-dup"}', 'utf8');
    const common = {
      tenant_id: TENANT,
      channel: 'indeed',
      external_source_id: 'apply-dup',
      body,
      content_type: 'application/json',
      requestId: 'req-3',
    };

    const a = await service.putIngestionObject(common);
    const b = await service.putIngestionObject(common);

    // Same dedup identity, distinct forensic objects (distinct receipt_uuid).
    expect(a.storage_ref).not.toBe(b.storage_ref);
    // Same bytes → same content hash.
    expect(a.sha256).toBe(b.sha256);
  });
});
