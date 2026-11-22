import type { AuthContextType } from '@aramo/auth';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString, StandardFonts } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { SenderEnvelopeService } from '../app/sender/sender-envelope.service.js';
import { bindImportedFields, uploadImportOptions } from '../app/sender/upload-field-import.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-5 /
// P2-6 — the Sign envelope document upload's opt-in field import, unit level (no database):
//   flags off: the stored bytes and the response are exactly what they were;
//   import_fields: a fillable PDF with field / document JavaScript (refused without the flag)
//     is stripped and flattened; its fields are created with the document, on the first
//     signing recipient (named warning); an XFA-only form is refused;
//   apply_text_tags: tags bind to recipients by name / email / role (case-insensitive); an
//     unknown role goes to the first recipient with a named warning; used tags are covered;
//   no signing recipient + fields to create: refused before anything is stored.

const AUTH = { sub: 'u1', tenant_id: 't1', scopes: [], consumer_type: 'sign' } as unknown as AuthContextType;
const N = PDFName.of;
const SELLER = { id: 's1', name: 'Pat Seller', email: 'pat@example.com', signer_role: 'Seller', recipient_kind: 'SIGNER', signing_order: 1 };
const BUYER = { id: 's2', name: 'Bo Buyer', email: 'bo@example.com', signer_role: null, recipient_kind: 'SIGNER', signing_order: 2 };
const COPY = { id: 's3', name: 'Cc Person', email: 'cc@example.com', signer_role: null, recipient_kind: 'RECEIVES_COPY', signing_order: 3 };

const jsAction = (doc: PDFDocument): PDFRef => doc.context.register(doc.context.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') }));

async function formPdf(opts: { active?: boolean; xfaOnly?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  if (opts.xfaOnly === true) {
    const xfa = doc.context.register(doc.context.stream('<xdp:xdp/>'));
    doc.catalog.set(N('AcroForm'), doc.context.obj({ Fields: [], XFA: xfa }));
    return doc.save({ useObjectStreams: false });
  }
  const form = doc.getForm();
  const name = form.createTextField('Full name');
  name.addToPage(page, { x: 50, y: 680, width: 220, height: 20 });
  const pick = form.createRadioGroup('plan');
  pick.addOptionToPage('Basic', page, { x: 50, y: 600, width: 12, height: 12 });
  pick.addOptionToPage('Pro', page, { x: 120, y: 600, width: 12, height: 12 });
  const sig = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('sig'), Type: 'Annot', Subtype: 'Widget', Rect: [50, 100, 280, 150], F: 4, P: page.ref }));
  doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray).push(sig);
  page.node.Annots()?.push(sig);
  if (opts.active === true) {
    name.acroField.dict.set(N('AA'), doc.context.obj({ K: jsAction(doc) }));
    doc.catalog.set(N('Names'), doc.context.obj({ JavaScript: doc.context.obj({ Names: [PDFString.of('calc'), jsAction(doc)] }) }));
  }
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function taggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Seller {{signature:seller}}', { x: 72, y: 700, size: 11, font });
  page.drawText('Buyer {{initials:BO@EXAMPLE.COM:optional}}', { x: 72, y: 660, size: 11, font });
  page.drawText('Chair {{date:Chair}}', { x: 72, y: 620, size: 11, font });
  page.drawText('Co {{company:Pat Seller}}', { x: 72, y: 580, size: 11, font });
  page.drawText('Bad {{payment:Pat Seller}}', { x: 72, y: 540, size: 11, font });
  return doc.save({ useObjectStreams: false });
}

function harness(signers: ReadonlyArray<Record<string, unknown>> = [SELLER, BUYER, COPY], existingFields: ReadonlyArray<Record<string, unknown>> = []) {
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
    getEnvelopeDetail: vi.fn(async () => ({ id: 'e1', status: 'DRAFT', documents: [{ id: 'd0', fields: existingFields }], signers })),
  };
  const ctx = { assertCanAuthor: vi.fn(async () => undefined), tenantKind: vi.fn(async () => 'BUSINESS') };
  const svc = new SenderEnvelopeService(repo as never, {} as never, ctx as never, { findUserById: vi.fn(async () => null) } as never, storage as never, {} as never, storageGate as never);
  // assertMayChange reads the envelope through describe; the upload's own logic is under test.
  vi.spyOn(svc, 'assertMayChange').mockResolvedValue(undefined as never);
  return { svc, repo, stored };
}

const b64 = (b: Uint8Array): string => Buffer.from(b).toString('base64');

describe('FIELD-PARITY-1 P2-5 / P2-6 — Sign upload flags', () => {
  it('parses the flags (default false; a non-boolean is refused)', () => {
    expect(uploadImportOptions({}, 'r')).toEqual({ import_fields: false, apply_text_tags: false });
    expect(uploadImportOptions({ import_fields: true, apply_text_tags: null }, 'r')).toEqual({ import_fields: true, apply_text_tags: false });
    expect(() => uploadImportOptions({ apply_text_tags: 'true' }, 'r')).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('flags off: stores the uploaded bytes and answers without field_import (a tagged PDF stays as is)', async () => {
    const h = harness();
    const bytes = await taggedPdf();
    const out = await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(bytes) }, 'r');
    expect(Buffer.from(h.stored[0] ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(out).not.toHaveProperty('field_import');
    expect(h.repo.getEnvelopeDetail).not.toHaveBeenCalled();
    expect(h.repo.addDraftDocument.mock.calls[0]?.[0]).not.toHaveProperty('fields');
  });

  it('flags off: a fillable PDF with JavaScript is refused exactly as before', async () => {
    const h = harness();
    await expect(h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await formPdf({ active: true })) }, 'r')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      context: { details: { reason: 'unsafe_pdf' } },
    });
  });
});

describe('FIELD-PARITY-1 P2-5 — import_fields on a Sign upload', () => {
  it('strips, flattens, and creates the form fields on the first signing recipient', async () => {
    const h = harness();
    const out = (await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await formPdf({ active: true })), import_fields: true }, 'r')) as {
      field_import: { fields: Array<Record<string, unknown>>; warnings: Array<{ code: string }>; stripped: string[] };
    };
    const doc = await PDFDocument.load(h.stored[0] ?? new Uint8Array());
    expect(doc.catalog.get(N('AcroForm'))).toBeUndefined();
    expect(/\/(JavaScript|JS|AA)[\s/<([]/.test(Buffer.from(h.stored[0] ?? []).toString('latin1'))).toBe(false);
    expect(out.field_import.stripped.sort()).toEqual(['/AA', '/AcroForm', '/JavaScript']);
    expect(out.field_import.fields.map((f) => [f['id'], f['source_name'], f['field_type'], f['signer_id'], f['label'], f['group_key'], f['group_rule']])).toEqual([
      ['f1', 'Full name', 'TEXT', 's1', null, null, null],
      // FIELD-PARITY-1 P3 T-5 — a radio group imports as a RADIO group.
      ['f2', 'plan', 'RADIO', 's1', 'Basic', 'plan', 'SELECT_ONE'],
      ['f3', 'plan', 'RADIO', 's1', 'Pro', 'plan', 'SELECT_ONE'],
      ['f4', 'sig', 'SIGNATURE', 's1', null, null, null],
    ]);
    expect(out.field_import.warnings.map((w) => w.code)).toEqual(['field_assigned_to_first_recipient']);
    const rows = (h.repo.addDraftDocument.mock.calls[0]?.[0] as { fields: Array<Record<string, unknown>> }).fields;
    expect(rows).toHaveLength(4);
    expect(rows[0]).not.toHaveProperty('source');
    expect(rows[0]).not.toHaveProperty('envelope_document_id');
  });

  it('a radio group key already used on the envelope gets a new key', async () => {
    const h = harness([SELLER], [{ group_key: 'plan' }]);
    const out = (await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await formPdf()), import_fields: true }, 'r')) as { field_import: { fields: Array<{ group_key: string | null }> } };
    expect(out.field_import.fields.map((f) => f.group_key)).toEqual([null, 'plan_2', 'plan_2', null]);
  });

  it('refuses an XFA-only form, and fields with no signing recipient, before storing', async () => {
    const h = harness();
    await expect(h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await formPdf({ xfaOnly: true })), import_fields: true }, 'r')).rejects.toMatchObject({
      context: { details: { reason: 'xfa_only_form' } },
    });
    const none = harness([COPY]);
    await expect(none.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(await formPdf()), import_fields: true }, 'r')).rejects.toMatchObject({
      statusCode: 422,
      context: { details: { reason: 'field_import_needs_recipient' } },
    });
    expect(h.stored).toHaveLength(0);
    expect(none.stored).toHaveLength(0);
  });
});

describe('FIELD-PARITY-1 P2-6 — apply_text_tags on a Sign upload', () => {
  it('binds tags to recipients, reports refused tags and unknown roles, and covers the used tags', async () => {
    const h = harness();
    const bytes = await taggedPdf();
    const out = (await h.svc.upload(AUTH, 'e1', { filename: 'a.pdf', content_base64: b64(bytes), apply_text_tags: true }, 'r')) as {
      field_import: { fields: Array<Record<string, unknown>>; warnings: Array<{ code: string }> };
    };
    expect(out.field_import.fields.map((f) => [f['field_type'], f['signer_id'], f['required'], f['source']])).toEqual([
      ['SIGNATURE', 's1', true, 'text_tag'],
      ['INITIALS', 's2', false, 'text_tag'],
      ['SIGN_DATE', 's1', true, 'text_tag'],
      ['COMPANY', 's1', true, 'text_tag'],
    ]);
    expect(out.field_import.warnings.map((w) => w.code).sort()).toEqual(['field_assigned_to_first_recipient', 'text_tag_role_unknown', 'text_tag_type_not_allowed']);
    expect(Buffer.from(h.stored[0] ?? []).equals(Buffer.from(bytes))).toBe(false);
  });
});

describe('bindImportedFields', () => {
  it('SIGNER_NAME gets the sender default name mode; every row names a recipient', () => {
    const f = { source: 'text_tag' as const, name: 'name:Bo Buyer', field_type: 'SIGNER_NAME' as const, page_number: 0, x: 1, y: 1, width: 50, height: 10, required: true, role: 'bo buyer', label: null, group_key: null, group_rule: null };
    const out = bindImportedFields([f], [SELLER, BUYER], 'r');
    expect(out.rows[0]).toMatchObject({ signer_id: 's2', name_mode: 'SIGNER_PROFILE' });
    expect(out.warnings).toEqual([]);
  });
});
