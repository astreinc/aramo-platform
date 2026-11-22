import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { FIXED_FORM_SCHEMA_V1 } from '@aramo/documents';
import { extractTextLayer } from '@aramo/documents-rendering';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFString, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { PlatformFixedFormsController } from '../document-templates-platform/platform-fixed-forms.controller.js';
import { acceptFixedFormPdf, prepareFixedFormPdf } from '../documents/fixed-form-pdf.js';
import { FixedFormService } from '../documents/fixed-form.service.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-5 /
// P2-6 — the console fixed-form upload's opt-in field import, unit level (no database):
//   flags off: the upload is exactly the §7.1 gate (same bytes, same refusals);
//   import_fields: a fillable PDF with field / document JavaScript (refused without the flag)
//     is stripped, flattened and stored; its fields become template_fixed_form catalog fields;
//     an XFA-only form is refused (xfa_only_form);
//   apply_text_tags: {{…}} tags become fields, refused tags are reported, every used tag is
//     covered with white on the stored PDF.

const ACTOR = '01900000-0000-7000-8000-0000000007a2';
const TEMPLATE = '01900000-0000-7000-8000-0000000007b1';
const VERSION = '01900000-0000-7000-8000-0000000007b2';
const TYPE = '01900000-0000-7000-8000-0000000007c1';
const N = PDFName.of;
const NONE = { import_fields: false, apply_text_tags: false };

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
  const name = form.createTextField('Employee Name');
  name.enableRequired();
  name.addToPage(page, { x: 50, y: 680, width: 220, height: 20 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 50, y: 640, width: 12, height: 12 });
  const status = form.createRadioGroup('status');
  status.addOptionToPage('Single', page, { x: 50, y: 600, width: 12, height: 12 });
  status.addOptionToPage('Married', page, { x: 120, y: 600, width: 12, height: 12 });
  const dept = form.createDropdown('dept');
  dept.setOptions(['HR', 'IT']);
  dept.addToPage(page, { x: 50, y: 560, width: 100, height: 20 });
  // A signature field (pdf-lib cannot create one): FT /Sig merged with its widget.
  const sig = doc.context.register(doc.context.obj({ FT: 'Sig', T: PDFString.of('Employee Signature'), Type: 'Annot', Subtype: 'Widget', Rect: [50, 100, 280, 150], F: 4, P: page.ref }));
  doc.catalog.lookup(N('AcroForm'), PDFDict).lookup(N('Fields'), PDFArray).push(sig);
  page.node.Annots()?.push(sig);
  if (opts.active === true) {
    name.acroField.dict.set(N('AA'), doc.context.obj({ K: jsAction(doc) }));
    doc.catalog.set(N('OpenAction'), jsAction(doc));
    doc.catalog.set(N('Names'), doc.context.obj({ JavaScript: doc.context.obj({ Names: [PDFString.of('calc'), jsAction(doc)] }) }));
  }
  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function taggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const line = (t: string, y: number): void => page.drawText(t, { x: 72, y, size: 11, font });
  line('Employee: {{signature:Employee}}', 700);
  line('Name {{name:employee:required}}', 660);
  line('Chair {{date:Chair}}', 620);
  line('Job {{title:Employee}}', 580);
  line('Seal {{stamp:Employee}}', 540);
  line('Ack {{checkbox:Employee:label=I have read the policy}}', 500);
  return doc.save({ useObjectStreams: false });
}

async function pageOperators(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(0).node.Contents();
  let out = '';
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i += 1) {
      const s = doc.context.lookup(contents.get(i) as PDFRef);
      if (s instanceof PDFRawStream) out += `${Buffer.from(decodePDFRawStream(s).decode()).toString('latin1')}\n`;
    }
  }
  return out;
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AramoError) return String((e.context?.details as { reason?: string } | undefined)?.reason ?? e.code);
    throw e;
  }
  throw new Error('expected a refusal');
}

describe('FIELD-PARITY-1 P2-5 / P2-6 — prepareFixedFormPdf', () => {
  it('flags off: the upload is the §7.1 gate alone (same bytes; the same refusal for active content)', async () => {
    const plain = await formPdf();
    const out = await prepareFixedFormPdf(plain, NONE, new Set(), 'r');
    expect(out.bytes).toBe(plain);
    expect(out.accepted).toEqual(await acceptFixedFormPdf(plain, 'r'));
    expect(out.fields).toEqual([]);
    expect(await reason(prepareFixedFormPdf(await formPdf({ active: true }), NONE, new Set(), 'r'))).toBe('pdf_unsafe');
  });

  it('import_fields: strips field / document JavaScript, flattens, and maps every field', async () => {
    const out = await prepareFixedFormPdf(await formPdf({ active: true }), { import_fields: true, apply_text_tags: false }, new Set(), 'r');
    expect([...out.stripped].sort()).toEqual(['/AA', '/AcroForm', '/JavaScript', '/OpenAction']);
    expect(out.accepted.sha256).toBe(createHash('sha256').update(out.bytes).digest('hex'));
    const doc = await PDFDocument.load(out.bytes);
    expect(doc.catalog.get(N('AcroForm'))).toBeUndefined();
    expect(doc.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    const raw = Buffer.from(out.bytes).toString('latin1');
    expect(/\/(JavaScript|JS|AA|OpenAction|XFA)[\s/<([]/.test(raw)).toBe(false);
    expect(out.fields.map((f) => [f.name, f.field_type, f.label, f.group_key, f.group_rule, f.required])).toEqual([
      ['Employee Name', 'TEXT', null, null, null, true],
      ['agree', 'CHECKBOX', 'agree', null, null, false],
      ['status', 'CHECKBOX', 'Single', 'status', 'SELECT_ONE', false],
      ['status', 'CHECKBOX', 'Married', 'status', 'SELECT_ONE', false],
      ['dept', 'TEXT', null, null, null, false],
      ['Employee Signature', 'SIGNATURE', null, null, null, false],
    ]);
    expect(out.fields.at(-1)).toMatchObject({ page_number: 0, x: 50, y: 100, width: 230, height: 50 });
    expect(out.warnings).toEqual([]);
  });

  it('import_fields: refuses an XFA-only form with a named reason', async () => {
    expect(await reason(prepareFixedFormPdf(await formPdf({ xfaOnly: true }), { import_fields: true, apply_text_tags: false }, new Set(), 'r'))).toBe('xfa_only_form');
  });

  it('import_fields: a PDF without a form is stored as uploaded', async () => {
    const bytes = await taggedPdf();
    const out = await prepareFixedFormPdf(bytes, { import_fields: true, apply_text_tags: false }, new Set(), 'r');
    expect(out.bytes).toBe(bytes);
    expect(out.fields).toEqual([]);
  });

  it('apply_text_tags: tags become fields; refused tags are reported and stay visible; used tags are covered', async () => {
    const bytes = await taggedPdf();
    const out = await prepareFixedFormPdf(bytes, { import_fields: false, apply_text_tags: true }, new Set(), 'r');
    // FIELD-PARITY-1 P3 (R-1) — {{title:…}} is a fixed-form type now (TITLE); {{stamp:…}} stays unknown.
    expect(out.fields.map((f) => [f.field_type, f.role, f.required, f.label])).toEqual([
      ['SIGNATURE', 'Employee', true, null],
      ['SIGNER_NAME', 'employee', true, null],
      ['SIGN_DATE', 'Chair', true, null],
      ['TITLE', 'Employee', true, null],
      ['CHECKBOX', 'Employee', false, 'I have read the policy'],
    ]);
    expect(out.warnings.map((w) => w.code).sort()).toEqual(['text_tag_type_unknown']);
    // Every field is on page 0, inside the page, at least 8 points each way.
    for (const f of out.fields) {
      expect(f.page_number).toBe(0);
      expect(f.width).toBeGreaterThanOrEqual(8);
      expect(f.height).toBeGreaterThanOrEqual(8);
      expect(f.x + f.width).toBeLessThanOrEqual(612);
    }
    // The stored PDF is not the upload, and it draws one white rectangle per used tag, after
    // the page text (the cover).
    expect(out.bytes).not.toBe(bytes);
    const ops = await pageOperators(out.bytes);
    const covers = ops.match(/1 1 1 rg\n0 w\n\[\] 0 d\n1 0 0 1 [\d.]+ [\d.]+ cm/g) ?? [];
    expect(covers).toHaveLength(5); // FIELD-PARITY-1 P3 — the {{title:…}} tag is used now too.
    expect(ops.indexOf('1 1 1 rg')).toBeGreaterThan(ops.lastIndexOf('Tj'));
    // The cover of the signature tag sits over the tag's glyph box (from the text layer).
    const layer = await extractTextLayer(bytes);
    const tagWord = layer[0]?.words.find((w) => w.t === '{{signature:Employee}}');
    expect(tagWord).toBeDefined();
    const sigField = out.fields[0];
    expect(sigField?.x).toBeCloseTo((tagWord?.x ?? 0) * 612, 0);
  });
});

describe('FIELD-PARITY-1 P2-5 / P2-6 — FixedFormService.uploadPdf', () => {
  function service(existing: Array<Record<string, unknown>> = []) {
    const version = {
      id: VERSION,
      template_id: TEMPLATE,
      version_number: 1,
      status: 'DRAFT',
      field_schema: {
        render_schema_version: FIXED_FORM_SCHEMA_V1,
        title: 'Offer',
        pdf: null,
        signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' },
      },
      previewed_fingerprint: null,
      content_fingerprint: 'fp',
    };
    const forms = {
      isFixedFormType: vi.fn(async () => true),
      getPlatformVersion: vi.fn(async () => ({ version, template: { id: TEMPLATE, name: 'Offer', document_type_id: TYPE } })),
      listFields: vi.fn(async () => existing),
      createPlatformAsset: vi.fn(async (a: { sha256: string; byte_size: number; page_count: number }) => ({ id: 'asset-1', ...a })),
      writePlatformDraft: vi.fn(async () => version),
    };
    const stored: Uint8Array[] = [];
    const storage = { putArtifact: vi.fn(async (a: { body: Buffer }) => stored.push(new Uint8Array(a.body))) };
    const svc = new FixedFormService(forms as never, {} as never, {} as never, storage as never);
    return { svc, forms, stored };
  }

  it('flags off: stores the upload unchanged and writes no fields', async () => {
    const { svc, forms, stored } = service();
    const bytes = await taggedPdf();
    const out = await svc.uploadPdf({ version_id: VERSION, bytes, actor: ACTOR, requestId: 'r' });
    expect(out.field_import).toBeNull();
    expect(Buffer.from(stored[0] ?? []).equals(Buffer.from(bytes))).toBe(true);
    expect(forms.listFields).not.toHaveBeenCalled();
    const write = forms.writePlatformDraft.mock.calls[0]?.[0] as { fields?: unknown };
    expect(write.fields).toBeUndefined();
  });

  it('apply_text_tags: appends the tag fields after the existing ones, binds roles, warns on an unknown role', async () => {
    const existing = [
      { field_key: 'employee_signature', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 1, y: 1, width: 100, height: 20, ordinal: 0, label: null, group_key: null, group_rule: null, min_selected: null, name_mode: null },
    ];
    const { svc, forms, stored } = service(existing);
    const bytes = await taggedPdf();
    const out = await svc.uploadPdf({ version_id: VERSION, bytes, actor: ACTOR, requestId: 'r', import: { import_fields: false, apply_text_tags: true } });
    expect(Buffer.from(stored[0] ?? []).equals(Buffer.from(bytes))).toBe(false);
    const write = forms.writePlatformDraft.mock.calls[0]?.[0] as { fields: Array<{ field_key: string; signer_role: string | null; ordinal: number }> };
    expect(write.fields.map((f) => [f.field_key, f.signer_role, f.ordinal])).toEqual([
      ['employee_signature', 'employee', 0],
      ['signature_employee', 'employee', 1],
      ['name_employee_required', 'employee', 2],
      ['date_chair', null, 3],
      ['title_employee', 'employee', 4],
      ['checkbox_employee_label_i_have_read_the_policy', 'employee', 5],
    ]);
    expect(out.field_import?.fields.map((f) => f.source)).toEqual(['text_tag', 'text_tag', 'text_tag', 'text_tag', 'text_tag']);
    expect(out.field_import?.warnings.map((w) => w.code).sort()).toEqual(['text_tag_role_unknown', 'text_tag_type_unknown']);
  });

  it('import_fields: form fields arrive without a role (the author assigns them)', async () => {
    const { svc, forms } = service();
    const out = await svc.uploadPdf({ version_id: VERSION, bytes: await formPdf({ active: true }), actor: ACTOR, requestId: 'r', import: { import_fields: true, apply_text_tags: false } });
    const write = forms.writePlatformDraft.mock.calls[0]?.[0] as { fields: Array<{ field_key: string; signer_role: string | null; group_key: string | null }> };
    expect(write.fields.map((f) => [f.field_key, f.signer_role, f.group_key])).toEqual([
      ['employee_name', null, null],
      ['agree', null, null],
      ['status', null, 'status'],
      ['status_2', null, 'status'],
      ['dept', null, null],
      ['employee_signature', null, null],
    ]);
    expect(out.field_import?.stripped).toContain('/AcroForm');
  });
});

describe('FIELD-PARITY-1 P2-5 / P2-6 — PUT …/fixed-form/pdf flags', () => {
  const platformAuth = { sub: ACTOR, consumer_type: 'platform', tenant_id: null, scopes: [] } as unknown as AuthContextType;
  const b64 = Buffer.from('%PDF-1.7').toString('base64');

  it('refuses a non-boolean flag; without flags the response is the view alone', async () => {
    const forms = { uploadPdf: vi.fn(async () => ({ field_import: null })), platformView: vi.fn(async () => ({ version_id: VERSION })) };
    const c = new PlatformFixedFormsController(forms as never);
    await expect(c.uploadPdf(VERSION, { content_base64: b64, import_fields: 'yes' }, platformAuth, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(forms.uploadPdf).not.toHaveBeenCalled();
    expect(await c.uploadPdf(VERSION, { content_base64: b64 }, platformAuth, 'r')).toEqual({ version_id: VERSION });
    expect(forms.uploadPdf.mock.calls[0]?.[0]).not.toHaveProperty('import');
  });

  it('with a flag the response adds field_import', async () => {
    const report = { fields: [], warnings: [], stripped: [] };
    const forms = { uploadPdf: vi.fn(async () => ({ field_import: report })), platformView: vi.fn(async () => ({ version_id: VERSION })) };
    const c = new PlatformFixedFormsController(forms as never);
    expect(await c.uploadPdf(VERSION, { content_base64: b64, apply_text_tags: true }, platformAuth, 'r')).toEqual({ version_id: VERSION, field_import: report });
    expect(forms.uploadPdf.mock.calls[0]?.[0]).toMatchObject({ import: { import_fields: false, apply_text_tags: true } });
  });
});
