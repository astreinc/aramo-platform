import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ObjectStorageService } from '@aramo/object-storage';
import {
  type DocumentStoragePort,
  type PutOwnedSourceInput,
  type PutOwnedSourceResult,
} from '@aramo/esign';

// PX-V1 F1 (D-1) — binds the E-Sign DocumentStoragePort to ObjectStorageService.
// OWNED source PDFs live in E-Sign's OWN object storage (never the Documents
// schema), addressed by an opaque key. E-Sign owns these bytes end to end
// (Independent-Digital-Signature-Platform Directive §16).
const MAX_SOURCE_BYTES = 26_214_400; // 25 MiB ceiling on a single source PDF.

@Injectable()
export class EsignObjectStorageDocumentAdapter implements DocumentStoragePort {
  constructor(private readonly storage: ObjectStorageService) {}

  async putOwnedSource(input: PutOwnedSourceInput): Promise<PutOwnedSourceResult> {
    const body = Buffer.from(input.bytes);
    const source_object_key = `esign/source/${input.tenant_id}/${input.envelope_id}/${randomUUID()}`;
    const requestId = `esign-owned-source-${randomUUID()}`;
    await this.storage.putObjectBytes({ storage_key: source_object_key, body, content_type: input.content_type, requestId });
    const source_sha256 = createHash('sha256').update(body).digest('hex');
    return { source_object_key, byte_size: body.byteLength, source_sha256 };
  }

  async getOwnedSource(source_object_key: string): Promise<Uint8Array> {
    const requestId = `esign-owned-source-get-${randomUUID()}`;
    const buf = await this.storage.getObjectBytes({ storage_key: source_object_key, requestId, maxBytes: MAX_SOURCE_BYTES });
    return new Uint8Array(buf);
  }
}
