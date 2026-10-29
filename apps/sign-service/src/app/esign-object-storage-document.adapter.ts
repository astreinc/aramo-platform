import { createHash, randomUUID } from 'node:crypto';

import { Injectable, Optional } from '@nestjs/common';
import { ObjectStorageService } from '@aramo/object-storage';
import {
  type DocumentStoragePort,
  type PutOwnedSourceInput,
  type PutOwnedSourceResult,
} from '@aramo/sign';

import { isSignBucketKey, isSignSourceKey, signSourceKey } from './custody/sign-artifact-storage.config.js';
import { SignArtifactStore } from './custody/sign-artifact-store.js';

// PX-V1 F1 (D-1) — binds the E-Sign DocumentStoragePort to ObjectStorageService.
// OWNED source PDFs live in E-Sign's OWN object storage (never the Documents
// schema), addressed by an opaque key. E-Sign owns these bytes end to end
// (Independent-Digital-Signature-Platform Directive §16).
//
// SX-2 (Executed-Artifact Custody and Isolation v1.0) — when the dedicated Sign
// artifact bucket is configured (SIGN_ARTIFACT_BUCKET), NEW sources are written there
// under `tenants/<tenant>/envelopes/<envelope>/source/<object_id>`. Reads route by key
// prefix: `tenants/` keys from the Sign bucket, legacy `esign/source/` keys from the
// platform document bucket. Dark (unset) = the legacy behaviour, unchanged.
const MAX_SOURCE_BYTES = 26_214_400; // 25 MiB ceiling on a single source PDF.

@Injectable()
export class EsignObjectStorageDocumentAdapter implements DocumentStoragePort {
  constructor(
    private readonly storage: ObjectStorageService,
    @Optional() private readonly signStore?: SignArtifactStore,
  ) {}

  plannedSourceKey(tenant_id: string, envelope_id: string, object_id: string): string {
    if (this.signStore?.enabled === true) return signSourceKey(tenant_id, envelope_id, object_id);
    return `esign/source/${tenant_id}/${envelope_id}/${object_id}`;
  }

  async putOwnedSource(input: PutOwnedSourceInput): Promise<PutOwnedSourceResult> {
    const body = Buffer.from(input.bytes);
    const object_id = input.object_id !== undefined && /^[0-9a-f-]{36}$/i.test(input.object_id) ? input.object_id : randomUUID();
    const source_object_key = this.plannedSourceKey(input.tenant_id, input.envelope_id, object_id);
    if (this.signStore?.enabled === true) {
      const put = await this.signStore.putSource({ key: source_object_key, body, content_type: input.content_type });
      return { source_object_key, byte_size: body.byteLength, source_sha256: put.sha256 };
    }
    const requestId = `esign-owned-source-${randomUUID()}`;
    await this.storage.putObjectBytes({ storage_key: source_object_key, body, content_type: input.content_type, requestId });
    const source_sha256 = createHash('sha256').update(body).digest('hex');
    return { source_object_key, byte_size: body.byteLength, source_sha256 };
  }

  async getOwnedSource(source_object_key: string): Promise<Uint8Array> {
    if (isSignBucketKey(source_object_key)) {
      if (this.signStore?.enabled !== true) throw new Error('Sign artifact bucket is not configured for a tenants/ source key');
      return new Uint8Array(await this.signStore.get(source_object_key, undefined, MAX_SOURCE_BYTES));
    }
    const requestId = `esign-owned-source-get-${randomUUID()}`;
    const buf = await this.storage.getObjectBytes({ storage_key: source_object_key, requestId, maxBytes: MAX_SOURCE_BYTES });
    return new Uint8Array(buf);
  }

  // Sign Mobile D-W6-3 — the source bytes of a deleted draft document. Only keys
  // under E-Sign's own source prefix are ever removed. SX-2: in the Sign bucket only
  // source keys are deletable, and only the current object (never a version).
  async deleteOwnedSource(source_object_key: string): Promise<void> {
    if (isSignBucketKey(source_object_key)) {
      if (!isSignSourceKey(source_object_key)) throw new Error('not an E-Sign source object key');
      if (this.signStore?.enabled !== true) throw new Error('Sign artifact bucket is not configured for a tenants/ source key');
      await this.signStore.deleteSource(source_object_key);
      return;
    }
    if (!source_object_key.startsWith('esign/source/')) throw new Error('not an E-Sign source object key');
    const requestId = `esign-owned-source-delete-${randomUUID()}`;
    await this.storage.deleteObjectByKey({ storage_key: source_object_key, requestId });
  }
}
