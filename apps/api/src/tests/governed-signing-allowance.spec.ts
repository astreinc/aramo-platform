import { describe, expect, it, vi } from 'vitest';
import { AramoError } from '@aramo/common';
import type { EnvelopeSummary, SignatureProviderPort } from '@aramo/documents-contracts';
import type { DocumentsRepository, RenderService } from '@aramo/documents';

import { GovernedDocumentSigningService } from '../document-signing/governed-document-signing.service.js';
import { EsignServiceHttpProvider } from '../esign/esign-service-http.provider.js';

// Multi-Provider directive §B/§D — a send refused for the allowance must stay
// recoverable: the envelope it left in DRAFT is sent on the next attempt (not
// reported as already sent), and the refusal reaches the caller with its reason.

const env = (over: Partial<EnvelopeSummary> = {}): EnvelopeSummary => ({ envelope_id: 'E1', status: 'SENT', signers: [], ...over });

function make(existing: EnvelopeSummary | null) {
  const signature = {
    findEnvelopeForDocument: vi.fn(async () => existing),
    createEnvelope: vi.fn(async () => env({ envelope_id: 'E-new', status: 'DRAFT' })),
    sendEnvelope: vi.fn(async (_t: string, id: string) => env({ envelope_id: id, status: 'SENT' })),
  } as unknown as SignatureProviderPort;
  const documents = {
    getCurrentRevision: vi.fn(async () => ({ id: 'rev-1', content_sha256: 'AAA' })),
    prepareDocument: vi.fn(async () => undefined),
  } as unknown as DocumentsRepository;
  const svc = new GovernedDocumentSigningService(documents, {} as RenderService, signature);
  const input = { tenant_id: 't1', document_id: 'doc-1', subject: 'RTR', execution_mode: 'SINGLE_SIGNATURE', recipient: { email: 'a@b.test', name: 'A' }, created_by: 'u1', requestId: 'r1' };
  return { svc, signature, input };
}

describe('GovernedDocumentSigningService.send — allowance recovery', () => {
  it('a DRAFT envelope left by a refused send is SENT on retry, never minted twice', async () => {
    const { svc, signature, input } = make(env({ envelope_id: 'E1', status: 'DRAFT' }));
    await expect(svc.send(input)).resolves.toEqual({ document_id: 'doc-1', envelope_id: 'E1', status: 'SENT' });
    expect(signature.sendEnvelope).toHaveBeenCalledWith('t1', 'E1');
    expect(signature.createEnvelope).not.toHaveBeenCalled();
  });

  it('an envelope already in flight is returned as is (duplicate guard unchanged)', async () => {
    const { svc, signature, input } = make(env({ envelope_id: 'E1', status: 'SENT' }));
    await expect(svc.send(input)).resolves.toMatchObject({ envelope_id: 'E1', status: 'SENT' });
    expect(signature.sendEnvelope).not.toHaveBeenCalled();
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
