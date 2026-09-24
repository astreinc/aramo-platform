// DOC-1a — concrete DocumentStoragePort adapter, bound at the composition root.
//
// Lives in apps/api (NOT in libs/documents) so the boundary lib keeps zero nx
// edge to @aramo/object-storage — the TranscriptArtifactStore precedent. The
// business domain depends only on DOCUMENT_STORAGE_PORT.

import { ObjectStorageService } from '@aramo/object-storage';
import {
  DocumentStorageNotSupportedError,
  type DocumentStoragePort,
  type LegalHoldInput,
  type PutArtifactInput,
  type PutArtifactResult,
  type ReadAccess,
  type RetentionInput,
} from '@aramo/documents';

export class AramoS3DocumentStorageAdapter implements DocumentStoragePort {
  constructor(private readonly storage: ObjectStorageService) {}

  async putArtifact(input: PutArtifactInput): Promise<PutArtifactResult> {
    const res = await this.storage.putObjectBytes({
      storage_key: input.storage_key,
      body: input.body,
      content_type: input.content_type,
      requestId: input.requestId,
    });
    return { storage_key: res.storage_ref, sha256: res.sha256 };
  }

  async getArtifact(input: { storage_key: string; requestId: string; maxBytes: number }): Promise<Buffer> {
    return this.storage.getObjectBytes(input);
  }

  async createReadAccess(input: {
    storage_key: string;
    requestId: string;
    expires_in_seconds?: number;
  }): Promise<ReadAccess> {
    const res = await this.storage.createPresignedGet({
      storage_key: input.storage_key,
      requestId: input.requestId,
      expires_in_seconds: input.expires_in_seconds,
    });
    return { url: res.presigned_url, expires_at: res.expires_at };
  }

  async headArtifact(input: {
    storage_key: string;
    requestId: string;
  }): Promise<{ byte_length: number; content_type: string | undefined } | null> {
    return this.storage.headObject(input);
  }

  async verifyArtifact(input: {
    storage_key: string;
    expected_sha256: string;
    requestId: string;
    maxBytes: number;
  }): Promise<boolean> {
    return this.storage.verifyObjectSha256(input);
  }

  // Deferred to the R27.1 Object-Lock/WORM increment — fail loudly, never
  // silently no-op an integrity control.
  createWriteAccess(): Promise<ReadAccess> {
    throw new DocumentStorageNotSupportedError('createWriteAccess');
  }

  applyRetention(_input: RetentionInput): Promise<void> {
    throw new DocumentStorageNotSupportedError('applyRetention');
  }

  applyLegalHold(_input: LegalHoldInput): Promise<void> {
    throw new DocumentStorageNotSupportedError('applyLegalHold');
  }
}
