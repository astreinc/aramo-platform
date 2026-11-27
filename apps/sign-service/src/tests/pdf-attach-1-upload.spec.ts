import type { AuthContextType } from '@aramo/auth';
import { findPdfAttachment } from '@aramo/documents-rendering';
import { PDFDocument, PDFName, PDFString, type PDFRef } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { SignApiService } from '../app/integrations/sign-api.service.js';
import { RegulatedSigningService } from '../app/regulated/regulated-signing.service.js';
import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';

// PDF-ATTACH-1 (Aramo-PDF-Attachment-Strip-1-Directive-v1_0-LOCKED) T-4 / T-5 — attached files
// are removed at the Sign upload points (send, Sign API) and the removal is reported; a clean
// file is stored as uploaded; the e-stamp certificate is never rewritten.

const AUTH = { sub: 'u1', tenant_id: 't1', scopes: [], consumer_type: 'sign' } as unknown as AuthContextType;
const N = PDFName.of;
const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

function fileSpec(doc: PDFDocument, name: string): PDFRef {
  const stream = doc.context.register(doc.context.flateStream('{"c2pa":"manifest"}', { Type: 'EmbeddedFile', Subtype: 'application/c2pa' }));
  return doc.context.register(doc.context.obj({ Type: 'Filespec', F: PDFString.of(name), EF: { F: stream } }));
}

async function pdf(opts: { attachment?: boolean; signed?: boolean; form?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (opts.form === true) doc.getForm().createTextField('Full name').addToPage(page, { x: 50, y: 680, width: 220, height: 20 });
  if (opts.attachment === true) {
    const spec = fileSpec(doc, 'Content Credentials');
    doc.catalog.set(N('Names'), doc.context.obj({ EmbeddedFiles: { Names: [PDFString.of('Content Credentials'), spec] } }));
    doc.catalog.set(N('AF'), doc.context.obj([spec]));
    doc.catalog.set(N('PageMode'), N('UseAttachments'));
  }
  if (opts.signed === true) {
    const sig = doc.context.register(doc.context.obj({ Type: 'Sig', ByteRange: [0, 10, 20, 30] }));
    doc.catalog.set(N('Perms'), doc.context.obj({ DocMDP: sig }));
  }
  return doc.save({ useObjectStreams: false });
}

async function hasAttachment(bytes: Uint8Array): Promise<boolean> {
  return findPdfAttachment(await PDFDocument.load(bytes, { updateMetadata: false })) !== null;
}

function sendHarness() {
  const stored: Uint8Array[] = [];
  const storageGate = { reserveUpload: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
  const storage = {
    putOwnedSource: vi.fn(async (a: { bytes: Uint8Array }) => {
      stored.push(a.bytes);
      return { source_object_key: 'k', byte_size: a.bytes.byteLength, source_sha256: 'a'.repeat(64) };
    }),
  };
  const repo = {
    addDraftDocument: vi.fn(async (input: { fields?: unknown[] }) => ({ id: 'd1', title: 'T', ordinal: 0, byte_size: 10, revision: 3, field_ids: (input.fields ?? []).map((_, i) => `f${i + 1}`) })),
    getEnvelopeDetail: vi.fn(async () => ({ id: 'e1', status: 'DRAFT', documents: [{ id: 'd0', fields: [] }], signers: [{ id: 's1', name: 'Pat', email: 'pat@example.com', signer_role: null, recipient_kind: 'SIGNER', signing_order: 1 }] })),
  };
  const ctx = { assertCanAuthor: vi.fn(async () => undefined), tenantKind: vi.fn(async () => 'BUSINESS') };
  const svc = new SenderEnvelopeService(repo as never, {} as never, ctx as never, { findUserById: vi.fn(async () => null) } as never, storage as never, {} as never, storageGate as never);
  vi.spyOn(svc, 'assertMayChange').mockResolvedValue(undefined as never);
  return { svc, repo, stored };
}

describe('PDF-ATTACH-1 — Sign send upload', () => {
  it('removes the attached file, stores the PDF without it and reports the count (response and event)', async () => {
    const h = sendHarness();
    const upload = await pdf({ attachment: true });
    const out = await h.svc.upload(AUTH, 'e1', { filename: 'incorporation.pdf', content_base64: b64(upload) }, 'r');
    expect(out).toMatchObject({ attachments_removed: 1 });
    const stored = h.stored[0] ?? new Uint8Array();
    expect(Buffer.from(stored).equals(Buffer.from(upload))).toBe(false);
    expect(await hasAttachment(stored)).toBe(false);
    expect(h.repo.addDraftDocument.mock.calls[0]?.[0]).toMatchObject({ attachments_removed: 1 });
  });

  it('a clean PDF is stored byte-for-byte and the answer has no attachments_removed', async () => {
    const h = sendHarness();
    const upload = await pdf();
    const out = await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(upload) }, 'r');
    expect(Buffer.from(h.stored[0] ?? []).equals(Buffer.from(upload))).toBe(true);
    expect(out).not.toHaveProperty('attachments_removed');
    expect(h.repo.addDraftDocument.mock.calls[0]?.[0]).not.toHaveProperty('attachments_removed');
  });

  it('a digitally signed PDF with an attached file is refused (attachments), nothing stored', async () => {
    const h = sendHarness();
    await expect(h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await pdf({ attachment: true, signed: true })) }, 'r')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'unsafe_pdf', pdf_problem: 'attachments' } },
    });
    expect(h.stored).toHaveLength(0);
  });

  it('the opt-in import path removes the attachment too, and still imports the form fields', async () => {
    const h = sendHarness();
    const out = (await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await pdf({ attachment: true, form: true })), import_fields: true }, 'r')) as { attachments_removed?: number; field_import?: { fields: unknown[] } };
    expect(out.attachments_removed).toBe(1);
    expect(out.field_import?.fields).toHaveLength(1);
    expect(await hasAttachment(h.stored[0] ?? new Uint8Array())).toBe(false);
  });
});

describe('PDF-ATTACH-1 — Sign API create', () => {
  function apiHarness() {
    const stored: Uint8Array[] = [];
    const repo = {
      createEnvelope: vi.fn(async () => ({ id: 'e9' })),
      addDocument: vi.fn(async () => ({ id: 'd9' })),
      addSigner: vi.fn(async () => ({ id: 's9' })),
      addField: vi.fn(async () => undefined),
    };
    const provider = { getEnvelope: vi.fn(async () => ({ envelope_id: 'e9', status: 'DRAFT', signers: [] })), sendEnvelope: vi.fn() };
    const storageGate = { reserveUpload: vi.fn(async () => undefined), release: vi.fn(async () => undefined) };
    const storage = {
      putOwnedSource: vi.fn(async (a: { bytes: Uint8Array }) => {
        stored.push(a.bytes);
        return { source_object_key: 'k', byte_size: a.bytes.byteLength, source_sha256: 'b'.repeat(64) };
      }),
    };
    const svc = new SignApiService(repo as never, provider as never, {} as never, storageGate as never, storage as never);
    return { svc, stored };
  }
  const apiAuth = { sub: 'u1', consumer_type: 'sign', actor_kind: 'user', tenant_id: 't1', scopes: ['sign:envelope:create'], iat: 0, exp: 0 } as unknown as AuthContextType;
  const integ = { application_key: 'acme-hr', application_kind: 'THIRD_PARTY', installation_id: 'i1', mode: 'USER', external_actor: null, external_role: null, grant_kind: 'STANDARD', bound_envelope_id: null } as never;
  const body = async (attachment: boolean) => ({ subject: 'NDA', documents: [{ content_base64: b64(await pdf({ attachment })) }], signers: [{ name: 'A', email: 'a@x.test' }] });

  it('removes attached files and adds the count to the envelope summary', async () => {
    const h = apiHarness();
    const out = await h.svc.create(apiAuth, integ, (await body(true)) as never, 'r');
    expect(out).toEqual({ envelope_id: 'e9', status: 'DRAFT', signers: [], attachments_removed: 1 });
    expect(await hasAttachment(h.stored[0] ?? new Uint8Array())).toBe(false);
  });

  it('a clean upload: the summary is unchanged', async () => {
    const h = apiHarness();
    expect(await h.svc.create(apiAuth, integ, (await body(false)) as never, 'r')).toEqual({ envelope_id: 'e9', status: 'DRAFT', signers: [] });
  });
});

describe('PDF-ATTACH-1 — the e-stamp certificate is never rewritten (T-5, ruling R3)', () => {
  it('an issued certificate with an attached file is refused (attachments), not stripped or stored', async () => {
    const storage = { putOwnedSource: vi.fn() };
    const storageGate = { reserveUpload: vi.fn() };
    const estamp = { poll: vi.fn(async () => ({ kind: 'issued', order_id: 'o1', pdf: await pdf({ attachment: true }) })), attach: vi.fn() };
    const svc = new RegulatedSigningService(
      { assertAvailable: vi.fn() } as never,
      { assertBusiness: vi.fn(async () => undefined) } as never,
      { assertMayChangeEnvelope: vi.fn(async () => undefined) } as never,
      {} as never,
      {} as never,
      estamp as never,
      storageGate as never,
      storage as never,
    );
    await expect(svc.refreshEstamp(AUTH, 'e1', 'r')).rejects.toMatchObject({ context: { details: { reason: 'unsafe_pdf', pdf_problem: 'attachments' } } });
    expect(storage.putOwnedSource).not.toHaveBeenCalled();
    expect(storageGate.reserveUpload).not.toHaveBeenCalled();
  });
});
