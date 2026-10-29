import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { EnvelopeSummary, SignatureProviderPort } from '@aramo/documents-contracts';
import type { DocumentsRepository, RenderService } from '@aramo/documents';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import type { SignatureRouter } from '../document-signing/signature-router.js';
import { SignApiClient } from '../sign/sign-api.client.js';

// Multi-Provider directive §B/§D/§E — governed sends route through the provider
// router: availability is asserted before anything is created, the provider is
// frozen on the new request, and a DRAFT left by a refused send is sent on retry.

const env = (over: Partial<EnvelopeSummary> = {}): EnvelopeSummary => ({ envelope_id: 'E1', status: 'SENT', signers: [], ...over });

const MANIFEST = { render_manifest: { signature_fields: [{ field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 150, height: 30 }, { field_type: 'SIGNER_NAME', page_number: 0, x: 240, y: 100, width: 150, height: 30 }, { field_type: 'SIGN_DATE', page_number: 0, x: 408, y: 100, width: 120, height: 30 }] } };

function make(existing: EnvelopeSummary | null, refuse = false, manifest: unknown = MANIFEST.render_manifest) {
  const port = {
    findEnvelopeForDocument: vi.fn(async () => existing),
    createEnvelope: vi.fn(async () => env({ envelope_id: 'E-new', status: 'DRAFT' })),
    sendEnvelope: vi.fn(async (_t: string, id: string) => env({ envelope_id: id, status: 'SENT' })),
  } as unknown as SignatureProviderPort;
  const router: SignatureRouter = {
    forNewSend: vi.fn(async () => {
      if (refuse) throw new AramoError('ESIGN_SEND_UNAVAILABLE', 'no', 409, { requestId: 'r1', details: { reason: 'LIMIT_REACHED' } });
      return { provider: 'aramo_sign' as const, port };
    }),
    forDocument: vi.fn(async () => ({ provider: 'aramo_sign' as const, port })),
    recordRoute: vi.fn(async () => undefined),
    recordAccepted: vi.fn(async () => undefined),
  };
  const documents = {
    getCurrentRevision: vi.fn(async () => ({ id: 'rev-1', content_sha256: 'AAA', render_manifest: manifest })),
    prepareDocument: vi.fn(async () => undefined),
  } as unknown as DocumentsRepository;
  const svc = new GovernedDocumentSigningService(documents, {} as RenderService, router);
  const input = { tenant_id: 't1', document_id: 'doc-1', subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', recipient: { email: 'a@b.test', name: 'A' }, created_by: 'u1', requestId: 'r1' };
  return { svc, port, router, documents, input };
}

describe('GovernedDocumentSigningService.send — routing and allowance recovery', () => {
  it('a new send freezes the selected provider on the request', async () => {
    const { svc, router, input } = make(null);
    await expect(svc.send(input)).resolves.toEqual({ document_id: 'doc-1', envelope_id: 'E-new', status: 'SENT' });
    expect(router.recordRoute).toHaveBeenCalledWith({ tenant_id: 't1', document_id: 'doc-1', document_revision_id: 'rev-1', provider: 'aramo_sign', provider_envelope_ref: 'E-new' });
  });

  it('an unavailable send is refused before the document is prepared or an envelope is created', async () => {
    const { svc, port, documents, input } = make(null, true);
    await expect(svc.send(input)).rejects.toMatchObject({ code: 'ESIGN_SEND_UNAVAILABLE' });
    expect(documents.prepareDocument).not.toHaveBeenCalled();
    expect(port.createEnvelope).not.toHaveBeenCalled();
  });

  it('a DRAFT envelope left by a refused send is SENT on retry, never minted twice', async () => {
    const { svc, port, input } = make(env({ envelope_id: 'E1', status: 'DRAFT' }));
    await expect(svc.send(input)).resolves.toEqual({ document_id: 'doc-1', envelope_id: 'E1', status: 'SENT' });
    expect(port.sendEnvelope).toHaveBeenCalledWith('t1', 'E1', undefined, undefined); // Addendum S6 — no actor supplied
    expect(port.createEnvelope).not.toHaveBeenCalled();
  });

  it('an envelope already in flight is returned as is (duplicate guard unchanged)', async () => {
    const { svc, port, input } = make(env({ envelope_id: 'E1', status: 'SENT' }));
    await expect(svc.send(input)).resolves.toMatchObject({ envelope_id: 'E1', status: 'SENT' });
    expect(port.sendEnvelope).not.toHaveBeenCalled();
  });
});

describe('GovernedDocumentSigningService.send — the signer signs on the frozen signature block', () => {
  it('places required SIGNATURE + SIGN_DATE fields from the frozen render manifest (the printed name is not a field)', async () => {
    const { svc, port, input } = make(null);
    await svc.send(input);
    const req = (port.createEnvelope as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as { fields: unknown[] };
    expect(req.fields).toEqual([
      { document_ordinal: 1, signer_signing_order: 1, field_type: 'SIGNATURE', page_number: 0, x: 72, y: 100, width: 150, height: 30, required: true },
      { document_ordinal: 1, signer_signing_order: 1, field_type: 'SIGN_DATE', page_number: 0, x: 408, y: 100, width: 120, height: 30, required: true },
    ]);
  });

  it('a signature-mode document without a signature block is refused before anything is prepared or created', async () => {
    for (const manifest of [null, {}, { signature_fields: [] }, { signature_fields: [{ field_type: 'SIGN_DATE', page_number: 0, x: 1, y: 1, width: 1, height: 1 }] }]) {
      const { svc, port, documents, router, input } = make(null, false, manifest);
      await expect(svc.send(input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422, context: { details: { reason: 'no_signature_field' } } });
      expect(documents.prepareDocument).not.toHaveBeenCalled();
      expect(router.forNewSend).not.toHaveBeenCalled();
      expect(port.createEnvelope).not.toHaveBeenCalled();
    }
  });
});

// Domain Isolation V1 §3 H-2 — the authenticated Sign API is the only Aramo Sign transport.
describe('SignApiClient — refusal details reach the caller', () => {
  it('keeps the error code, status and details (reason, limit, period end)', async () => {
    const body = { error: { code: 'ESIGN_ALLOWANCE_EXHAUSTED', message: 'used up', details: { reason: 'LIMIT_REACHED', limit: 100, used: 100, period_end: '2026-11-01T00:00:00.000Z' } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })));
    try {
      const grant = { access_token: 'sgt_test', expires_in: 300, tenant_id: 't1', installation_id: 'i1' };
      const err = await new SignApiClient().call('POST', '/v1/sign/api/envelopes/E1/send', grant, {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AramoError);
      expect(err).toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED', statusCode: 409, context: { details: { reason: 'LIMIT_REACHED', limit: 100 } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
