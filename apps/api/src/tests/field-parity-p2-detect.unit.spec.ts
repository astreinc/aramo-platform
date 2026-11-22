import { createHash } from 'node:crypto';

import type { AuthContextType } from '@aramo/auth';
import { FIXED_FORM_SCHEMA_V1 } from '@aramo/documents';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { PlatformFixedFormsController } from '../document-templates-platform/platform-fixed-forms.controller.js';
import { FixedFormService } from '../documents/fixed-form.service.js';

// FIELD-PARITY-1 (Aramo-Sign-Field-Placement-Enterprise-Parity-Directive-v1_0-LOCKED) §5 P2-4 —
// the console fixed-form "Suggest fields" route, unit level (no database):
//   GET /platform/document-templates/versions/:versionId/fixed-form/field-suggestions
// runs the shared detector (@aramo/sign-fields detectFields, the one Sign's envelope route runs)
// over the stored PDF, limited to the fixed-form palette (a "Title:" label becomes TEXT there).

const ACTOR = '01900000-0000-7000-8000-0000000008a2';
const TEMPLATE = '01900000-0000-7000-8000-0000000008b1';
const VERSION = '01900000-0000-7000-8000-0000000008b2';
const TYPE = '01900000-0000-7000-8000-0000000008c1';

async function formPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Signature: ______________________', { x: 72, y: 200, size: 12, font });
  page.drawText('Title:', { x: 72, y: 600, size: 12, font });
  page.drawText('Email:', { x: 72, y: 560, size: 12, font });
  page.drawRectangle({ x: 72, y: 400, width: 300, height: 80, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  return doc.save();
}

function service(bytes: Uint8Array | null, opts: { readFails?: boolean } = {}) {
  const sha256 = bytes === null ? 'none' : createHash('sha256').update(bytes).digest('hex');
  const pdf = bytes === null ? null : { asset_id: 'asset-1', sha256, byte_size: bytes.byteLength, page_count: 1, pages: [{ width: 612, height: 792 }] };
  const version = {
    id: VERSION,
    status: 'DRAFT',
    field_schema: { render_schema_version: FIXED_FORM_SCHEMA_V1, title: 'Form', pdf, signing: { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' } },
  };
  const forms = {
    isFixedFormType: vi.fn(async () => true),
    getPlatformVersion: vi.fn(async () => ({ version, template: { id: TEMPLATE, name: 'Form', document_type_id: TYPE } })),
    findPlatformAsset: vi.fn(async () => ({ id: 'asset-1', storage_key: 'k', sha256 })),
  };
  const storage = {
    getArtifact: vi.fn(async () => {
      if (opts.readFails === true) throw new Error('storage down');
      return Buffer.from(bytes ?? []);
    }),
  };
  return { svc: new FixedFormService(forms as never, {} as never, {} as never, storage as never), forms, storage };
}

describe('FIELD-PARITY-1 P2-4 — FixedFormService.fieldSuggestions', () => {
  it('suggests fixed-form types only: Signature on its line, a Title / Email label as TEXT, the empty box as TEXT', async () => {
    const { svc } = service(await formPdf());
    const out = await svc.fieldSuggestions(VERSION, 'r');
    const byReason = Object.fromEntries(out.suggestions.map((s) => [s.reason, s.type]));
    expect(byReason).toEqual({ 'label:Signature': 'SIGNATURE', 'label:Title': 'TEXT', 'label:Email': 'TEXT', empty_box: 'TEXT' });
    const sig = out.suggestions.find((s) => s.type === 'SIGNATURE');
    expect(sig).toMatchObject({ page: 1, page_number: 0 });
    expect(Math.abs((sig?.y ?? 0) - 200)).toBeLessThan(3);
    expect(out.skipped_pages).toEqual([]);
    // Every suggestion is a fixed-form palette type.
    for (const s of out.suggestions) expect(['SIGNATURE', 'INITIALS', 'SIGNER_NAME', 'SIGN_DATE', 'TEXT', 'CHECKBOX']).toContain(s.type);
  });

  it('a version without a PDF, or a PDF that cannot be read, is an empty answer', async () => {
    expect(await service(null).svc.fieldSuggestions(VERSION, 'r')).toEqual({ suggestions: [], skipped_pages: [] });
    expect(await service(await formPdf(), { readFails: true }).svc.fieldSuggestions(VERSION, 'r')).toEqual({ suggestions: [], skipped_pages: [] });
    const notPdf = service(new TextEncoder().encode('not a pdf'));
    expect(await notPdf.svc.fieldSuggestions(VERSION, 'r')).toEqual({ suggestions: [], skipped_pages: [] });
  });

  it('a template that is not a fixed form is refused like the other routes (409 not_a_fixed_form)', async () => {
    const { svc, forms } = service(await formPdf());
    forms.isFixedFormType.mockResolvedValueOnce(false);
    await expect(svc.fieldSuggestions(VERSION, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('FIELD-PARITY-1 P2-4 — GET …/fixed-form/field-suggestions', () => {
  const platformAuth = { sub: ACTOR, consumer_type: 'platform', tenant_id: null, scopes: [] } as unknown as AuthContextType;

  it('answers the service result to a platform caller', async () => {
    const result = { suggestions: [], skipped_pages: [{ page: 2, reason: 'rotated' as const }] };
    const forms = { fieldSuggestions: vi.fn(async () => result) };
    const c = new PlatformFixedFormsController(forms as never);
    expect(await c.fieldSuggestions(VERSION, platformAuth, 'r')).toBe(result);
    expect(forms.fieldSuggestions).toHaveBeenCalledWith(VERSION, 'r');
  });

  it('refuses a tenant token (tier_mismatch)', async () => {
    const forms = { fieldSuggestions: vi.fn() };
    const c = new PlatformFixedFormsController(forms as never);
    const tenant = { ...platformAuth, consumer_type: 'tenant' } as unknown as AuthContextType;
    await expect(c.fieldSuggestions(VERSION, tenant, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    expect(forms.fieldSuggestions).not.toHaveBeenCalled();
  });
});
