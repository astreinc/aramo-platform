import { createHash } from 'node:crypto';

import { AramoError } from '@aramo/common';
import type { AuthContextType } from '@aramo/auth';
import { FIXED_FORM_SCHEMA_V1, type PublishedFixedForm, type TemplateAuditPort } from '@aramo/documents';
import { PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it, vi } from 'vitest';

import { PlatformFixedFormsController } from '../document-templates-platform/platform-fixed-forms.controller.js';
import { acceptFixedFormPdf, stampFixedFormValues } from '../documents/fixed-form-pdf.js';
import { FixedFormService, fixedFormContentOf, parseFieldInput } from '../documents/fixed-form.service.js';
import { SignFixedFormsService } from '../documents/sign-fixed-forms.service.js';
import { SignTemplateLibraryService } from '../documents/sign-template-library.service.js';
import { TenantFixedFormsController } from '../documents/tenant-fixed-forms.controller.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §7 — fixed legal forms, unit level:
//   §7.1 the PDF gate (PDF only, 10 MB, must parse, no active content — also inside compressed
//        object streams);
//   §7.2 the field / layout shape and the fixed-form preview gate;
//   §7.3 tenant visibility (entitlement filter, Hide / Show audited, refused without audit);
//   §7.4 Sign: hidden forms never listed, "Use" freezes the stored PDF pinned to the version,
//        the library delegates fixed forms at the TP-4 seam.

const TENANT = '01900000-0000-7000-8000-0000000006a1';
const ACTOR = '01900000-0000-7000-8000-0000000006a2';
const TEMPLATE = '01900000-0000-7000-8000-0000000006b1';
const VERSION = '01900000-0000-7000-8000-0000000006b2';
const TYPE = '01900000-0000-7000-8000-0000000006c1';
const ASSET = '01900000-0000-7000-8000-0000000006d1';

async function pdfBytes(pages = 1, mutate?: (d: PDFDocument) => void, useObjectStreams = false): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i += 1) d.addPage([612, 792]);
  mutate?.(d);
  return d.save({ useObjectStreams });
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

const SIGNING = { roles: [{ role_key: 'employee', label: 'Employee', kind: 'SIGNER', order: 1 }], routing_mode: 'PARALLEL' };

describe('TEMPLATE-PRODUCT-1 TP-6 §7.1 — the official PDF gate', () => {
  it('accepts a plain PDF and measures its pages', async () => {
    const bytes = await pdfBytes(2);
    const out = await acceptFixedFormPdf(bytes, 'r');
    expect(out.page_count).toBe(2);
    expect(out.pages).toEqual([
      { width: 612, height: 792 },
      { width: 612, height: 792 },
    ]);
    expect(out.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(out.byte_size).toBe(bytes.byteLength);
  });

  it('refuses a file that is not a PDF, an empty file and one over 10 MB', async () => {
    expect(await reason(acceptFixedFormPdf(new Uint8Array(Buffer.from('hello world')), 'r'))).toBe('pdf_invalid');
    expect(await reason(acceptFixedFormPdf(new Uint8Array(0), 'r'))).toBe('pdf_invalid');
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(Buffer.from('%PDF-1.7'));
    expect(await reason(acceptFixedFormPdf(big, 'r'))).toBe('pdf_too_large');
  });

  it('refuses active content in plain bytes (JavaScript open action)', async () => {
    const bytes = await pdfBytes(1, (d) => {
      d.catalog.set(PDFName.of('OpenAction'), d.context.obj({ S: 'JavaScript', JS: 'app.alert(1)' }));
    });
    expect(await reason(acceptFixedFormPdf(bytes, 'r'))).toBe('pdf_unsafe');
  });

  it('refuses active content hidden in a compressed object stream (deep scan)', async () => {
    const bytes = await pdfBytes(
      1,
      (d) => {
        d.getPage(0).node.set(PDFName.of('AA'), d.context.obj({ O: d.context.obj({ S: 'SubmitForm' }) }));
      },
      true,
    );
    // The raw bytes no longer show the key (it sits in a Flate object stream)…
    expect(Buffer.from(bytes).toString('latin1').includes('/AA')).toBe(false);
    // …the parsed-object scan still refuses it.
    expect(await reason(acceptFixedFormPdf(bytes, 'r'))).toBe('pdf_unsafe');
  });

  it('stamping prints the prefilled values; no stamp leaves the bytes unchanged', async () => {
    const bytes = await pdfBytes(1);
    expect(await stampFixedFormValues(bytes, [])).toBe(bytes);
    const stamped = await stampFixedFormValues(bytes, [{ page_number: 0, x: 72, y: 600, width: 200, height: 18, text: 'Nimbus Leasing — 東京' }]);
    expect(stamped.byteLength).toBeGreaterThan(bytes.byteLength);
    expect((await PDFDocument.load(stamped)).getPageCount()).toBe(1);
  });
});

describe('TEMPLATE-PRODUCT-1 TP-6 §7.2 — fields and layout', () => {
  it('parseFieldInput accepts the six types and refuses anything else with a stable reason', () => {
    const f = parseFieldInput({ field_key: 'sig_1', field_type: 'SIGNATURE', signer_role: 'employee', page_number: 0, x: 1.234, y: 2, width: 100, height: 20 }, 0, 'r');
    expect(f).toMatchObject({ field_key: 'sig_1', required: true, binding_key: null, x: 1.23, ordinal: 0 });
    const r = (raw: unknown): string => {
      try {
        parseFieldInput(raw, 0, 'r');
      } catch (e) {
        return String(((e as AramoError).context?.details as { reason: string }).reason);
      }
      return 'ok';
    };
    expect(r({ field_key: 'x', field_type: 'IMAGE', page_number: 0, x: 0, y: 0, width: 9, height: 9 })).toBe('field_type_invalid');
    expect(r({ field_key: 'Bad Key', field_type: 'TEXT', page_number: 0, x: 0, y: 0, width: 9, height: 9 })).toBe('field_key_invalid');
    expect(r({ field_key: 'x', field_type: 'TEXT', page_number: -1, x: 0, y: 0, width: 9, height: 9 })).toBe('field_position_invalid');
    expect(r({ field_key: 'x', field_type: 'TEXT', page_number: 0, x: 0, y: 0, width: 9, height: 9, value: 'v' })).toBe('field_unknown_member');
  });

  it('fixedFormContentOf parses roles with the shared signing parser (invalid → reported)', () => {
    const ok = fixedFormContentOf({ render_schema_version: FIXED_FORM_SCHEMA_V1, title: 'I-9', pdf: null, signing: SIGNING }, 'x');
    expect(ok.signing_issue).toBeNull();
    expect(ok.content.signing.roles.map((r) => r.role_key)).toEqual(['employee']);
    const bad = fixedFormContentOf({ render_schema_version: FIXED_FORM_SCHEMA_V1, signing: { roles: [], routing_mode: 'PARALLEL' } }, 'Fallback');
    expect(bad.signing_issue).toBe('signing_roles_required');
    expect(bad.content.title).toBe('Fallback');
  });

  function service(over: { fields?: unknown[]; field_schema?: unknown; status?: string; fixed?: boolean } = {}) {
    const version = {
      id: VERSION,
      template_id: TEMPLATE,
      version_number: 1,
      status: over.status ?? 'DRAFT',
      field_schema: over.field_schema ?? { render_schema_version: FIXED_FORM_SCHEMA_V1, title: 'I-9', pdf: null, signing: SIGNING },
      previewed_fingerprint: null,
      content_fingerprint: 'fp',
    };
    const forms = {
      isFixedFormType: vi.fn(async () => over.fixed ?? true),
      getPlatformVersion: vi.fn(async () => ({ version, template: { id: TEMPLATE, name: 'I-9', document_type_id: TYPE } })),
      listFields: vi.fn(async () => over.fields ?? []),
      writePlatformDraft: vi.fn(async () => version),
    };
    const templates = {
      findDocumentTypeTemplateConfig: vi.fn(async () => ({ id: TYPE, active: true, type_class: 'TEMPLATE', template_kind: 'FIXED_FORM', products: ['sign'] })),
      recordPlatformPreview: vi.fn(async () => version),
    };
    const variables = { listActive: vi.fn(async () => [{ key: 'organization.name', label: 'Organization name', group_label: 'Org', data_type: 'TEXT', sample_value: 'Acme', products: ['ats', 'sign'] }]) };
    const svc = new FixedFormService(forms as never, templates as never, variables as never, {} as never);
    return { svc, forms, templates };
  }

  it('saveLayout refuses an invalid role set and duplicate field keys before writing', async () => {
    const { svc, forms } = service();
    expect(await reason(svc.saveLayout({ version_id: VERSION, body: { signing: { roles: [], routing_mode: 'PARALLEL' } }, requestId: 'r' }))).toBe('signing_roles_required');
    const dup = { field_key: 'a', field_type: 'SIGNATURE', signer_role: 'employee', page_number: 0, x: 1, y: 1, width: 50, height: 20 };
    expect(await reason(svc.saveLayout({ version_id: VERSION, body: { fields: [dup, dup] }, requestId: 'r' }))).toBe('field_key_duplicate');
    expect(forms.writePlatformDraft).not.toHaveBeenCalled();
  });

  it('saveLayout writes roles + fields in one draft write', async () => {
    const { svc, forms } = service();
    const f = { field_key: 'a', field_type: 'SIGNATURE', signer_role: 'employee', page_number: 0, x: 1, y: 1, width: 50, height: 20 };
    await svc.saveLayout({ version_id: VERSION, body: { signing: SIGNING, fields: [f] }, requestId: 'r' });
    expect(forms.writePlatformDraft).toHaveBeenCalledWith(
      expect.objectContaining({ version_id: VERSION, field_schema: expect.objectContaining({ signing: SIGNING }), fields: [expect.objectContaining({ field_key: 'a', ordinal: 0 })] }),
    );
  });

  it('a template whose type is not FIXED_FORM is refused (409 not_a_fixed_form)', async () => {
    const { svc } = service({ fixed: false });
    expect(await reason(svc.platformView(VERSION, 'r'))).toBe('not_a_fixed_form');
  });

  it('preview is refused with the issues while the form is incomplete, and records nothing', async () => {
    const { svc, templates } = service();
    let details: Record<string, unknown> = {};
    await svc.preview(VERSION, 'r').catch((e: AramoError) => (details = e.context?.details as Record<string, unknown>));
    expect(details['reason']).toBe('fixed_form_incomplete');
    expect((details['issues'] as Array<{ code: string }>).map((i) => i.code)).toEqual(expect.arrayContaining(['pdf_required', 'fields_required']));
    expect(templates.recordPlatformPreview).not.toHaveBeenCalled();
  });

  it('preview records the §18 preview when the form is complete', async () => {
    const pdf = { asset_id: ASSET, sha256: 'b'.repeat(64), byte_size: 10, page_count: 1, pages: [{ width: 612, height: 792 }] };
    const fields = [{ field_key: 'sig', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 10, y: 10, width: 100, height: 20, ordinal: 0 }];
    const { svc, templates } = service({ fields, field_schema: { render_schema_version: FIXED_FORM_SCHEMA_V1, title: 'I-9', pdf, signing: SIGNING } });
    const out = await svc.preview(VERSION, 'r');
    expect(out.previewed).toBe(true);
    expect(templates.recordPlatformPreview).toHaveBeenCalledWith(VERSION);
  });
});

const platformAuth = { sub: ACTOR, consumer_type: 'platform', tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;
const tenantAuth = { sub: ACTOR, consumer_type: 'recruiter', tenant_id: TENANT, scopes: [] } as unknown as AuthContextType;

describe('TEMPLATE-PRODUCT-1 TP-6 — platform routes', () => {
  it('a tenant token is refused (tier tripwire) and the upload needs base64 content', async () => {
    const forms = { uploadPdf: vi.fn(), platformView: vi.fn() };
    const c = new PlatformFixedFormsController(forms as never);
    await expect(c.view(VERSION, tenantAuth, 'r')).rejects.toMatchObject({ code: 'INSUFFICIENT_PERMISSIONS' });
    await expect(c.uploadPdf(VERSION, { content_base64: '***' }, platformAuth, 'r')).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(forms.uploadPdf).not.toHaveBeenCalled();
  });
});

function published(over: Partial<PublishedFixedForm['template']> = {}): PublishedFixedForm {
  return {
    template: {
      id: TEMPLATE,
      document_type_id: TYPE,
      name: 'Form I-9',
      description: null,
      products: ['sign'],
      current_version_id: VERSION,
      withdraw_effective_at: null,
      updated_at: new Date('2026-11-01T00:00:00Z'),
      ...over,
    },
    version: {
      id: VERSION,
      version_number: 1,
      activated_at: new Date('2026-11-02T00:00:00Z'),
      field_schema: {
        render_schema_version: FIXED_FORM_SCHEMA_V1,
        title: 'Form I-9',
        pdf: { asset_id: ASSET, sha256: 'c'.repeat(64), byte_size: 10, page_count: 1, pages: [{ width: 612, height: 792 }] },
        signing: SIGNING,
      },
    },
    type: { id: TYPE, key: 'I9', name: 'Form I-9', products: ['sign'], category: 'Employment' },
  };
}

describe('TEMPLATE-PRODUCT-1 TP-6 §7.3 — tenant visibility', () => {
  function controller(capabilities: string[], audit?: TemplateAuditPort, hidden = new Map<string, boolean>()) {
    const repo = {
      listPublishedFixedForms: vi.fn(async (i: { products?: readonly string[] }) => ((i.products ?? []).includes('sign') ? [published()] : [])),
      visibilityFor: vi.fn(async () => hidden),
      setVisibility: vi.fn(async () => false),
      listFields: vi.fn(async () => []),
    };
    const entitlements = { getCapabilities: vi.fn(async () => new Set(capabilities)) };
    const c = new TenantFixedFormsController(repo as never, {} as never, entitlements as never, audit);
    return { c, repo };
  }

  it('lists only the forms tagged with a product the tenant is entitled to; shown by default', async () => {
    expect((await controller(['core', 'ats']).c.list(tenantAuth)).items).toEqual([]);
    const items = (await controller(['core', 'sign']).c.list(tenantAuth)).items;
    expect(items).toEqual([expect.objectContaining({ id: TEMPLATE, hidden: false, page_count: 1, version_number: 1 })]);
    const hidden = (await controller(['core', 'sign'], undefined, new Map([[TEMPLATE, true]])).c.list(tenantAuth)).items;
    expect(hidden[0]?.hidden).toBe(true);
  });

  it('Hide writes the tenant row and the governance audit; refused without the audit seam', async () => {
    const audit = { recordGovernance: vi.fn(async () => undefined) } as unknown as TemplateAuditPort;
    const { c, repo } = controller(['core', 'sign'], audit);
    const out = await c.hide(tenantAuth, TEMPLATE, 'r');
    expect(out.hidden).toBe(true);
    expect(repo.setVisibility).toHaveBeenCalledWith({ tenant_id: TENANT, template_id: TEMPLATE, hidden: true, updated_by: ACTOR });
    expect(audit.recordGovernance).toHaveBeenCalledWith(expect.objectContaining({ action: 'fixed_form_hidden', tenant_id: TENANT, subject_id: TEMPLATE }));
    await expect(controller(['core', 'sign']).c.show(tenantAuth, TEMPLATE, 'r')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });

  it('a form the tenant is not entitled to reads as not found', async () => {
    const audit = { recordGovernance: vi.fn() } as unknown as TemplateAuditPort;
    await expect(controller(['core', 'ats'], audit).c.hide(tenantAuth, TEMPLATE, 'r')).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });
});

describe('TEMPLATE-PRODUCT-1 TP-6 §7.4 — Sign', () => {
  async function sign(opts: { hidden?: boolean; fields?: unknown[]; replay?: boolean } = {}) {
    const source = await pdfBytes(1);
    const sha = createHash('sha256').update(source).digest('hex');
    const form = published();
    (form.version.field_schema as { pdf: { sha256: string } }).pdf.sha256 = sha;
    const fields = opts.fields ?? [
      { field_key: 'sig', field_type: 'SIGNATURE', binding_key: null, signer_role: 'employee', required: true, page_number: 0, x: 72, y: 72, width: 160, height: 32, ordinal: 0 },
      { field_key: 'employer', field_type: 'TEXT', binding_key: 'organization.name', signer_role: null, required: true, page_number: 0, x: 72, y: 600, width: 200, height: 18, ordinal: 1 },
    ];
    const revisions: Array<Record<string, unknown>> = [];
    const forms = {
      listPublishedFixedForms: vi.fn(async () => [form]),
      listFixedFormTypes: vi.fn(async () => [form.type]),
      visibilityFor: vi.fn(async () => new Map(opts.hidden ? [[TEMPLATE, true]] : [])),
      listFields: vi.fn(async () => fields),
      getPlatformTemplate: vi.fn(async () => ({ id: TEMPLATE, document_type_id: TYPE })),
      isFixedFormType: vi.fn(async () => true),
      writeFrozenRevision: vi.fn(async (i: Record<string, unknown>) => {
        revisions.push(i);
        return { revision_id: 'rev-1' };
      }),
    };
    const service = { readPdf: vi.fn(async () => Buffer.from(source)), allowedVariables: vi.fn(async () => [{ key: 'organization.name', label: 'Organization name', group: 'Org', data_type: 'TEXT', sample_value: null }]) };
    const stored = new Map<string, Buffer>();
    const documents = {
      createDocument: vi.fn(async () => ({ id: 'doc-1' })),
      getDocument: vi.fn(async () => ({ id: 'doc-1', title: 'Form I-9' })),
      getCurrentRevision: vi.fn(async () =>
        revisions.length === 0 ? null : { id: 'rev-1', content_sha256: revisions[0]!['sha256'], template_version_id: VERSION, byte_size: revisions[0]!['byte_size'] },
      ),
    };
    const templates = {
      findVersionByIdOwnerAware: vi.fn(async () => ({ id: VERSION, template_id: TEMPLATE, version_number: 1, field_schema: form.version.field_schema })),
      listFieldDefinitionsOwnerAware: vi.fn(async () => fields),
    };
    const idempotency = { lookup: vi.fn(async () => (opts.replay ? { kind: 'replay', response_body: { document_id: 'doc-1' } } : { kind: 'miss' })) };
    const storage = { putArtifact: vi.fn(async (i: { storage_key: string; body: Buffer }) => (stored.set(i.storage_key, i.body), { storage_key: i.storage_key, sha256: 'x' })) };
    const svc = new SignFixedFormsService({
      forms: forms as never,
      service: service as never,
      templates: templates as never,
      documents: documents as never,
      idempotency: idempotency as never,
      storage: storage as never,
      organizationValues: async () => new Map([['organization.name', 'Nimbus Leasing']]),
    });
    return { svc, forms, documents, storage, stored, revisions, sha };
  }

  it('lists a visible form tagged sign as FIXED_FORM with its roles; a hidden form is never listed', async () => {
    const { svc } = await sign();
    const items = await svc.list(TENANT);
    expect(items).toEqual([
      expect.objectContaining({ template_id: TEMPLATE, owner_scope: 'PLATFORM', resolution: 'AVAILABLE', template_kind: 'FIXED_FORM', signer_role_count: 1 }),
    ]);
    expect(items[0]?.variables).toEqual([{ key: 'organization.name', label: 'Organization name', group: 'Org', source: 'ORGANIZATION', value: 'Nimbus Leasing' }]);
    expect(await (await sign({ hidden: true })).svc.list(TENANT)).toEqual([]);
    await expect((await sign({ hidden: true })).svc.preview({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, requestId: 'r' })).rejects.toMatchObject({ code: 'TEMPLATE_NOT_FOUND' });
  });

  it('"Use" freezes the stored PDF with the prefilled value printed, pinned to the version; only signer fields go back', async () => {
    const { svc, revisions, stored, sha } = await sign();
    const out = await svc.render({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, created_by: ACTOR, client_id: null, idempotency_key: 'k-12345678', requestId: 'r' });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({ tenant_id: TENANT, document_id: 'doc-1', template_version_id: VERSION });
    expect((revisions[0]!['render_manifest'] as { fixed_form: Record<string, unknown> }).fixed_form).toEqual({
      template_id: TEMPLATE,
      source_asset_id: ASSET,
      source_sha256: sha,
      prefilled_keys: ['organization.name'],
    });
    const key = [...stored.keys()][0]!;
    expect(key).toMatch(new RegExp(`^documents/${TENANT}/doc-1/rendered/[0-9a-f]{64}\\.pdf$`));
    expect(out).toMatchObject({ document_id: 'doc-1', template_version_id: VERSION, template_kind: 'FIXED_FORM', signature_fields: [] });
    expect(out.field_definitions.map((f) => f.field_key)).toEqual(['sig']);
    expect(out.signing?.roles.map((r) => r.role_key)).toEqual(['employee']);
  });

  it('a replayed key returns the same frozen revision without writing again', async () => {
    const first = await sign();
    await first.svc.render({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, created_by: ACTOR, client_id: null, idempotency_key: 'k-12345678', requestId: 'r' });
    const { documents } = first;
    documents.createDocument.mockClear();
    const lookup = vi.fn(async () => ({ kind: 'replay', response_body: { document_id: 'doc-1' } }));
    (first.svc as unknown as { d: { idempotency: { lookup: typeof lookup } } }).d.idempotency.lookup = lookup;
    const again = await first.svc.render({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, created_by: ACTOR, client_id: null, idempotency_key: 'k-12345678', requestId: 'r' });
    expect(again.document_id).toBe('doc-1');
    expect(documents.createDocument).not.toHaveBeenCalled();
    expect(first.revisions).toHaveLength(1);
  });

  it('the Sign library delegates fixed forms at the TP-4 seam (list appends, preview / render delegate)', async () => {
    const fixedForms = {
      list: vi.fn(async () => [{ template_id: TEMPLATE } as never]),
      handles: vi.fn(async (id: string) => id === TEMPLATE),
      preview: vi.fn(async () => ({ template_id: TEMPLATE }) as never),
      render: vi.fn(async () => ({ document_id: 'doc-1' }) as never),
    };
    const lib = new SignTemplateLibraryService({
      templates: { listConfiguredTemplateTypes: vi.fn(async () => []) } as never,
      documents: {} as never,
      render: {} as never,
      idempotency: {} as never,
      storage: {} as never,
      resolver: {} as never,
      binding: {} as never,
      tenants: { findById: vi.fn(async () => ({ id: TENANT })) } as never,
      caps: { isConfigurable: vi.fn(async () => true) } as never,
      fixedForms: fixedForms as never,
    });
    expect((await lib.list({ tenant_id: TENANT, client_id: null, requestId: 'r' })).items).toEqual([{ template_id: TEMPLATE }]);
    await lib.preview({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, requestId: 'r' });
    await lib.render({ tenant_id: TENANT, template_id: TEMPLATE, values: {}, created_by: ACTOR, client_id: null, idempotency_key: 'k-12345678', requestId: 'r' });
    expect(fixedForms.preview).toHaveBeenCalledTimes(1);
    expect(fixedForms.render).toHaveBeenCalledTimes(1);
  });
});
