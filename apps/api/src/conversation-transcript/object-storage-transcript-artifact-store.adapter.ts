// CI-B5Z — the production TRANSCRIPT_ARTIFACT_STORE binding, over the existing
// ObjectStorageService (encrypted bucket, no public objects). Keys are
// tenant-scoped + opaque (no transcript text / PII), reusing the B4 key builders.
// This is the concrete adapter B3/B4 left unbound (they shipped the port + an
// in-memory fake only). Bytes never flow through logs.

import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '@aramo/object-storage';
import {
  TranscriptArtifactNotFoundError,
  TranscriptArtifactWriteError,
  buildNormalizedArtifactKey,
  buildSourceArtifactKey,
  type PutNormalizedInput,
  type PutSourceInput,
  type TranscriptArtifactStore,
} from '@aramo/conversation-transcript';

import { ZOOM_TRANSCRIPT_MAX_BYTES } from './zoom/zoom-transcript.constants.js';

@Injectable()
export class ObjectStorageTranscriptArtifactStore implements TranscriptArtifactStore {
  constructor(private readonly storage: ObjectStorageService) {}

  async putSource(input: PutSourceInput): Promise<{ ref: string; sha256: string }> {
    const key = buildSourceArtifactKey(input.tenant_id, input.ref_basis);
    try {
      const { storage_ref, sha256 } = await this.storage.putObjectBytes({
        storage_key: key,
        body: input.bytes,
        content_type: 'text/plain; charset=utf-8',
        requestId: randomUUID(),
      });
      return { ref: storage_ref, sha256 };
    } catch {
      throw new TranscriptArtifactWriteError(true);
    }
  }

  async putNormalized(input: PutNormalizedInput): Promise<{ ref: string }> {
    const key = buildNormalizedArtifactKey(input.tenant_id, input.transcript_id);
    try {
      const { storage_ref } = await this.storage.putObjectBytes({
        storage_key: key,
        body: input.bytes,
        content_type: 'application/json; charset=utf-8',
        requestId: randomUUID(),
      });
      return { ref: storage_ref };
    } catch {
      throw new TranscriptArtifactWriteError(true);
    }
  }

  /** Defense-in-depth: a ref must live under this tenant's key prefix. */
  private assertTenantRef(tenantId: string, ref: string): void {
    if (!ref.startsWith(`conversation-transcript/${tenantId}/`)) {
      throw new TranscriptArtifactNotFoundError();
    }
  }

  async getSource(tenantId: string, ref: string): Promise<Buffer> {
    this.assertTenantRef(tenantId, ref);
    try {
      return await this.storage.getObjectBytes({
        storage_key: ref,
        requestId: randomUUID(),
        maxBytes: ZOOM_TRANSCRIPT_MAX_BYTES,
      });
    } catch {
      throw new TranscriptArtifactNotFoundError();
    }
  }

  async deleteNormalized(tenantId: string, ref: string): Promise<void> {
    this.assertTenantRef(tenantId, ref);
    await this.storage.deleteObjectByKey({ storage_key: ref, requestId: randomUUID() });
  }

  async deleteSource(tenantId: string, ref: string): Promise<void> {
    this.assertTenantRef(tenantId, ref);
    await this.storage.deleteObjectByKey({ storage_key: ref, requestId: randomUUID() });
  }
}
