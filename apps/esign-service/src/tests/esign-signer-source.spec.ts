import { describe, expect, it, vi } from 'vitest';
import type { DocumentSourceProviderPort, EsignService, SessionContext } from '@aramo/esign';

import { EsignSignerController } from '../app/esign-http.controller.js';

// PX-V1 F3 — signer document + source routes. At baseline 130bfb65 the signing
// surface returned only 3 ids from exchange and had NO source/field-list route.
// These prove the source route wires resolveSession → resolveSignerSource → the
// mode-dispatching source port, and that neither route leaks tenant_id.

const TENANT = 'TENANT-SECRET-8f2c';
const ctx: SessionContext = { session_id: 's1', tenant_id: TENANT, envelope_id: 'e1', signer_id: 'sg1' };

describe('EsignSignerController F3 — source + document routes', () => {
  it('source: resolveSession → resolveSignerSource → source port; returns base64, no tenant leak', async () => {
    const descriptor = { tenant_id: TENANT, source_mode: 'OWNED' as const, document_ref: null, document_revision_ref: null, source_object_key: 'esign/source/k', content_type: 'application/pdf' };
    const service = {
      resolveSession: vi.fn(async () => ctx),
      resolveSignerSource: vi.fn(async () => descriptor),
    } as unknown as EsignService;
    let received: unknown;
    const port = {
      getSourcePdf: vi.fn(async (d: unknown) => { received = d; return new Uint8Array([1, 2, 3]); }),
    } as unknown as DocumentSourceProviderPort;

    const controller = new EsignSignerController(service, port);
    const res = await controller.source({ token: 'tok', document_id: 'd1' }, 'req-1');

    expect(service.resolveSession).toHaveBeenCalledWith('tok');
    expect(service.resolveSignerSource).toHaveBeenCalledWith(ctx, 'd1');
    expect(received).toBe(descriptor); // the full descriptor (incl. tenant) reaches the port server-side
    expect(res).toEqual({ source_base64: Buffer.from([1, 2, 3]).toString('base64'), content_type: 'application/pdf' });
    expect(JSON.stringify(res)).not.toContain(TENANT); // response never carries tenant
  });

  it('document: returns the signer view; never touches the source port', async () => {
    const view = { documents: [{ document_id: 'd1', title: 'a.pdf', ordinal: 1 }], fields: [{ field_id: 'f1', document_id: 'd1', field_type: 'SIGNATURE', page_number: 0, x: 72, y: 120, width: null, height: null, required: true }] };
    const service = {
      resolveSession: vi.fn(async () => ctx),
      getSignerDocumentView: vi.fn(async () => view),
    } as unknown as EsignService;
    const port = { getSourcePdf: vi.fn() } as unknown as DocumentSourceProviderPort;

    const controller = new EsignSignerController(service, port);
    const res = await controller.document({ token: 'tok' }, 'req-1');

    expect(res).toBe(view);
    expect(port.getSourcePdf).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).not.toContain(TENANT);
  });
});
