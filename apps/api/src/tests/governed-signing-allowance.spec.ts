import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { EnvelopeSummary, SignatureProviderPort } from '@aramo/documents-contracts';
import type { DocumentsRepository, RenderService } from '@aramo/documents';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import type { SignatureRouter } from '../document-signing/signature-router.js';
import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';

// Multi-Provider directive §B/§D/§E — governed sends route through the provider
// router: availability is asserted before anything is created, the provider is
// frozen on the new request, and a DRAFT left by a refused send is sent on retry.

const env = (over: Partial<EnvelopeSummary> = {}): EnvelopeSummary => ({ envelope_id: 'E1', status: 'SENT', signers: [], ...over });

function make(existing: EnvelopeSummary | null, refuse = false) {
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
  };
  const documents = {
    getCurrentRevision: vi.fn(async () => ({ id: 'rev-1', content_sha256: 'AAA' })),
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
    expect(port.sendEnvelope).toHaveBeenCalledWith('t1', 'E1');
    expect(port.createEnvelope).not.toHaveBeenCalled();
  });

  it('an envelope already in flight is returned as is (duplicate guard unchanged)', async () => {
    const { svc, port, input } = make(env({ envelope_id: 'E1', status: 'SENT' }));
    await expect(svc.send(input)).resolves.toMatchObject({ envelope_id: 'E1', status: 'SENT' });
    expect(port.sendEnvelope).not.toHaveBeenCalled();
  });
});

describe('EsignServiceHttpProvider — refusal details reach the caller', () => {
  it('keeps the error code, status and details (reason, limit, period end)', async () => {
    const body = { error: { code: 'ESIGN_ALLOWANCE_EXHAUSTED', message: 'used up', details: { reason: 'LIMIT_REACHED', limit: 100, used: 100, period_end: '2026-11-01T00:00:00.000Z' } } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 409 })));
    try {
      const err = await new EsignServiceHttpProvider().sendEnvelope('t1', 'E1').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AramoError);
      expect(err).toMatchObject({ code: 'ESIGN_ALLOWANCE_EXHAUSTED', statusCode: 409, context: { details: { reason: 'LIMIT_REACHED', limit: 100 } } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
