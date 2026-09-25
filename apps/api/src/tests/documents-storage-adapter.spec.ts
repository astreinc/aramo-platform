import type { ObjectStorageService } from '@aramo/object-storage';
import { DocumentStorageNotSupportedError } from '@aramo/documents';
import { describe, expect, it, vi } from 'vitest';

import { AramoS3DocumentStorageAdapter } from '../documents/aramo-s3-document-storage.adapter.js';

// DOC-1a boundary 5 — the adapter delegates to ObjectStorageService and fails
// loudly for the capabilities deferred to the R27.1 Object-Lock increment.

function stubStorage(overrides: Record<string, unknown> = {}): ObjectStorageService {
  return {
    putObjectBytes: vi.fn().mockResolvedValue({ storage_ref: 'tenant/doc/k1', sha256: 'abc123' }),
    getObjectBytes: vi.fn().mockResolvedValue(Buffer.from('bytes')),
    createPresignedGet: vi.fn().mockResolvedValue({ presigned_url: 'https://signed', expires_at: '2026-01-01T00:00:00Z' }),
    headObject: vi.fn().mockResolvedValue({ byte_length: 5, content_type: 'application/pdf' }),
    verifyObjectSha256: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as ObjectStorageService;
}

describe('AramoS3DocumentStorageAdapter (DOC-1a)', () => {
  it('putArtifact delegates to putObjectBytes and maps storage_ref -> storage_key', async () => {
    const storage = stubStorage();
    const adapter = new AramoS3DocumentStorageAdapter(storage);
    const res = await adapter.putArtifact({
      storage_key: 'tenant/doc/k1',
      body: Buffer.from('x'),
      content_type: 'application/pdf',
      requestId: 'r1',
    });
    expect(res).toEqual({ storage_key: 'tenant/doc/k1', sha256: 'abc123' });
    expect(storage.putObjectBytes).toHaveBeenCalledOnce();
  });

  it('verifyArtifact and headArtifact delegate to the object-storage integrity methods', async () => {
    const storage = stubStorage();
    const adapter = new AramoS3DocumentStorageAdapter(storage);
    expect(
      await adapter.verifyArtifact({ storage_key: 'k', expected_sha256: 'abc123', requestId: 'r', maxBytes: 10 }),
    ).toBe(true);
    expect(storage.verifyObjectSha256).toHaveBeenCalledOnce();
    expect(await adapter.headArtifact({ storage_key: 'k', requestId: 'r' })).toEqual({
      byte_length: 5,
      content_type: 'application/pdf',
    });
  });

  it('createReadAccess maps the presigned result to the port shape', async () => {
    const adapter = new AramoS3DocumentStorageAdapter(stubStorage());
    const access = await adapter.createReadAccess({ storage_key: 'k', requestId: 'r' });
    expect(access).toEqual({ url: 'https://signed', expires_at: '2026-01-01T00:00:00Z' });
  });

  it('deferred capabilities throw DocumentStorageNotSupportedError (never silently no-op)', async () => {
    const adapter = new AramoS3DocumentStorageAdapter(stubStorage());
    expect(() => adapter.createWriteAccess()).toThrow(DocumentStorageNotSupportedError);
    await expect(
      Promise.resolve().then(() =>
        adapter.applyRetention({ storage_key: 'k', retain_until: new Date(0), requestId: 'r' }),
      ),
    ).rejects.toBeInstanceOf(DocumentStorageNotSupportedError);
    await expect(
      Promise.resolve().then(() => adapter.applyLegalHold({ storage_key: 'k', enabled: true, requestId: 'r' })),
    ).rejects.toBeInstanceOf(DocumentStorageNotSupportedError);
  });
});
