import { describe, expect, it } from 'vitest';
import { type DocumentStoragePort } from '@aramo/esign';

import { EnvelopeDocumentSourceResolver } from '../app/envelope-document-source.resolver.js';
import { type DocumentSourceHttpAdapter } from '../app/document-source-http.adapter.js';

// PX-V1 F1 (D-1) — the mode-dispatching source resolver. Proves the OWNED path
// (E-Sign owns the bytes; NO Core Documents / apps/api pull) and that the legacy
// CORE_REF path is delegated unchanged. This behavior did not exist at baseline
// 130bfb65: the port was bound directly to DocumentSourceHttpAdapter, so EVERY
// source read was a Documents HTTP pull and there was no OWNED concept.

const OWNED_BYTES = new Uint8Array([9, 8, 7]);
const CORE_BYTES = new Uint8Array([1, 2, 3]);

function build() {
  let httpCalls = 0;
  let storageCalls = 0;
  let lastStorageKey: string | undefined;
  const http = {
    getSourcePdf: async () => {
      httpCalls += 1;
      return CORE_BYTES;
    },
  } as unknown as DocumentSourceHttpAdapter;
  const storage: DocumentStoragePort = {
    putOwnedSource: async () => ({ source_object_key: 'k', byte_size: 0, source_sha256: 'x' }),
    getOwnedSource: async (key: string) => {
      storageCalls += 1;
      lastStorageKey = key;
      return OWNED_BYTES;
    },
  };
  const resolver = new EnvelopeDocumentSourceResolver(http, storage);
  return { resolver, counts: () => ({ httpCalls, storageCalls, lastStorageKey }) };
}

describe('EnvelopeDocumentSourceResolver (PX-V1 F1)', () => {
  it('OWNED reads from E-Sign object storage and never pulls Documents', async () => {
    const { resolver, counts } = build();
    const bytes = await resolver.getSourcePdf({
      tenant_id: 't1',
      source_mode: 'OWNED',
      source_object_key: 'esign/source/t1/e1/obj',
      document_ref: null,
      document_revision_ref: null,
    });
    expect(bytes).toEqual(OWNED_BYTES);
    // The decisive standalone invariant: zero Documents/apps/api pulls.
    expect(counts()).toEqual({ httpCalls: 0, storageCalls: 1, lastStorageKey: 'esign/source/t1/e1/obj' });
  });

  it('CORE_REF delegates to the Documents HTTP adapter, untouched', async () => {
    const { resolver, counts } = build();
    const bytes = await resolver.getSourcePdf({
      tenant_id: 't1',
      source_mode: 'CORE_REF',
      document_ref: 'doc-1',
      document_revision_ref: 'rev-1',
      source_object_key: null,
    });
    expect(bytes).toEqual(CORE_BYTES);
    expect(counts()).toEqual({ httpCalls: 1, storageCalls: 0, lastStorageKey: undefined });
  });

  it('OWNED without an object key fails closed (never silently pulls Documents)', async () => {
    const { resolver, counts } = build();
    await expect(
      resolver.getSourcePdf({ tenant_id: 't1', source_mode: 'OWNED', source_object_key: null }),
    ).rejects.toThrow(/source_object_key/);
    expect(counts()).toEqual({ httpCalls: 0, storageCalls: 0, lastStorageKey: undefined });
  });
});
