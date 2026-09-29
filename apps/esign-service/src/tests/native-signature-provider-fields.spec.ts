import { describe, expect, it, vi } from 'vitest';
import type { EsignRepository, EsignService } from '@aramo/esign';
import { type CreateEnvelopeRequest } from '@aramo/documents-contracts';

import { NativeAramoSignatureProvider } from '../app/native-aramo-signature.provider.js';

// PX-V1 F2 — createEnvelope activates the SignatureField model. At baseline
// 130bfb65 createEnvelope had no `fields` handling and addField had no production
// caller; this proves the create path now defines positioned fields, additively.

function mkRepo(addField: ReturnType<typeof vi.fn>): EsignRepository {
  return {
    createEnvelope: vi.fn(async () => ({ id: 'env-1' })),
    // Return an id keyed to the ordinal / signing_order so resolution is observable.
    addDocument: vi.fn(async (i: { ordinal: number }) => ({ id: `doc-${i.ordinal}` })),
    addSigner: vi.fn(async (i: { signing_order: number }) => ({ id: `sg-${i.signing_order}` })),
    addField,
    getEnvelopeFull: vi.fn(async () => ({ id: 'env-1', status: 'DRAFT', subject: 'S', signers: [] })),
  } as unknown as EsignRepository;
}

const mkService = (): EsignService => ({}) as unknown as EsignService;

function baseReq(fields?: CreateEnvelopeRequest['fields']): CreateEnvelopeRequest {
  return {
    tenant_id: 't1',
    subject: 'Agreement',
    execution_mode: 'SINGLE_SIGNATURE',
    created_by: 'actor-1',
    documents: [{ document_ref: 'd', document_revision_ref: 'r', title: 'a.pdf', source_sha256: 'x', ordinal: 1 }],
    signers: [{ email: 'a@b.com', name: 'A', signing_order: 1 }],
    fields,
  };
}

describe('NativeAramoSignatureProvider.createEnvelope — PX-V1 F2 fields', () => {
  it('adds each supplied field with the resolved envelope_document_id + signer_id', async () => {
    const addField = vi.fn(async () => ({ id: 'f' }));
    const provider = new NativeAramoSignatureProvider(mkRepo(addField), mkService(), undefined);

    await provider.createEnvelope(
      baseReq([
        { document_ordinal: 1, signer_signing_order: 1, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true },
        { document_ordinal: 1, field_type: 'SIGN_DATE', page_number: 0, x: 72, y: 150 },
      ]),
    );

    expect(addField).toHaveBeenCalledTimes(2);
    expect(addField).toHaveBeenNthCalledWith(1, expect.objectContaining({
      tenant_id: 't1', envelope_document_id: 'doc-1', signer_id: 'sg-1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, required: true,
    }));
    expect(addField).toHaveBeenNthCalledWith(2, expect.objectContaining({
      envelope_document_id: 'doc-1', signer_id: undefined, field_type: 'SIGN_DATE', x: 72, y: 150,
    }));
  });

  it('is backward-compatible: no fields supplied → addField never called (ATS RTR/Offer path)', async () => {
    const addField = vi.fn(async () => ({ id: 'f' }));
    const provider = new NativeAramoSignatureProvider(mkRepo(addField), mkService(), undefined);
    await provider.createEnvelope(baseReq(undefined));
    expect(addField).not.toHaveBeenCalled();
  });

  it('fails closed on an invalid field and writes no field row', async () => {
    const addField = vi.fn(async () => ({ id: 'f' }));
    const provider = new NativeAramoSignatureProvider(mkRepo(addField), mkService(), undefined);
    await expect(
      provider.createEnvelope(baseReq([{ document_ordinal: 9, field_type: 'SIGNATURE', page_number: 0, x: 1, y: 1 }])),
    ).rejects.toThrow(/document_ordinal 9/);
    expect(addField).not.toHaveBeenCalled();
  });
});
