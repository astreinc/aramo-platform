import { Inject, Injectable } from '@nestjs/common';
import {
  DOCUMENT_STORAGE_PORT,
  type DocumentSourceProviderPort,
  type DocumentSourceRequest,
  type DocumentStoragePort,
} from '@aramo/esign';

import { DocumentSourceHttpAdapter } from './document-source-http.adapter.js';

// PX-V1 F1 (D-1) — mode-dispatching source resolver bound as the single
// DOCUMENT_SOURCE_PROVIDER_PORT. It keeps the two source contexts strictly
// separate:
//   OWNED    → bytes E-Sign owns in its own object storage (standalone path).
//   CORE_REF → a frozen Core Documents revision pulled over HTTP (legacy ATS
//              path), delegated UNCHANGED to DocumentSourceHttpAdapter.
// A standalone (non-ATS) envelope never triggers a Documents/apps/api fetch.
@Injectable()
export class EnvelopeDocumentSourceResolver implements DocumentSourceProviderPort {
  constructor(
    private readonly coreRef: DocumentSourceHttpAdapter,
    @Inject(DOCUMENT_STORAGE_PORT) private readonly owned: DocumentStoragePort,
  ) {}

  async getSourcePdf(input: DocumentSourceRequest): Promise<Uint8Array> {
    if (input.source_mode === 'OWNED') {
      if (typeof input.source_object_key !== 'string' || input.source_object_key.length === 0) {
        throw new Error('OWNED source fetch requires a source_object_key');
      }
      return this.owned.getOwnedSource(input.source_object_key);
    }
    return this.coreRef.getSourcePdf(input);
  }
}
