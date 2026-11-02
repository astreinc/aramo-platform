import { describe, expect, it } from 'vitest';
import type { DocumentTypeTemplateConfig, DocumentTypeTemplateConfigReader, TemplateVariableRow } from '@aramo/documents';

import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RTR_HTML_SCHEMA_V1 } from '../rtr/rtr-html-content.js';

import { fakeCatalog, seededRtrCatalogRows } from './fixtures/rtr-seed-catalog.js';

// TEMPLATE-PRODUCT-1 (Implementation Directive v1.0 LOCKED) §5 — the generic editable
// contract: configurability from data (§5.1), one content contract rtr-html-v1 (§5.2),
// allowed variables = active catalog rows whose products intersect the type's (§5.3). RTR keeps
// its exact binding result (the ATS RTR regression gate).

const RTR = RIGHT_TO_REPRESENT_TYPE_ID;
const NDA = '0000aaaa-0000-4000-8000-000000000001'; // EDITABLE, sign only
const LEASE = '0000aaaa-0000-4000-8000-000000000002'; // EDITABLE, ats only
const I9 = '0000aaaa-0000-4000-8000-000000000003'; // FIXED_FORM
const UNSET = '0000aaaa-0000-4000-8000-000000000004'; // kind NULL (not configured)
const RETIRED = '0000aaaa-0000-4000-8000-000000000005'; // EDITABLE but inactive
const TALENT = '0000aaaa-0000-4000-8000-000000000006'; // UPLOAD

function cfg(id: string, over: Partial<DocumentTypeTemplateConfig> = {}): DocumentTypeTemplateConfig {
  return { id, active: true, type_class: 'TEMPLATE', template_kind: 'EDITABLE', products: ['ats', 'sign'], ...over };
}

const TYPES: Record<string, DocumentTypeTemplateConfig> = {
  [RTR]: cfg(RTR),
  [NDA]: cfg(NDA, { products: ['sign'] }),
  [LEASE]: cfg(LEASE, { products: ['ats'] }),
  [I9]: cfg(I9, { template_kind: 'FIXED_FORM', products: ['sign'] }),
  [UNSET]: cfg(UNSET, { template_kind: null, products: [] }),
  [RETIRED]: cfg(RETIRED, { active: false }),
  [TALENT]: cfg(TALENT, { type_class: 'UPLOAD', template_kind: null, products: [] }),
};

const reader: DocumentTypeTemplateConfigReader = {
  async findDocumentTypeTemplateConfig(id) {
    return TYPES[id] ?? null;
  },
};

// The catalog as the database holds it since TP-1 (lowercase keys): the 8 RTR rows `ats`, the
// 7 organization.* rows `ats`+`sign`.
function dbCatalogRows(): TemplateVariableRow[] {
  return seededRtrCatalogRows().map((r) => ({ ...r, products: r.key.startsWith('organization.') ? ['ats', 'sign'] : ['ats'] }));
}

const caps = new RtrTemplateCapabilities(fakeCatalog(dbCatalogRows()), reader);

function html(body: string) {
  return { render_schema_version: RTR_HTML_SCHEMA_V1, title: 'Mutual NDA', html: body, logo: null };
}

describe('TEMPLATE-PRODUCT-1 TP-4 — generic editable contract', () => {
  it('§5.1 isConfigurable = active + TEMPLATE + EDITABLE (from data)', async () => {
    expect(await caps.isConfigurable(RTR)).toBe(true);
    expect(await caps.isConfigurable(NDA)).toBe(true);
    expect(await caps.isConfigurable(LEASE)).toBe(true);
    expect(await caps.isConfigurable(I9)).toBe(false);
    expect(await caps.isConfigurable(UNSET)).toBe(false);
    expect(await caps.isConfigurable(RETIRED)).toBe(false);
    expect(await caps.isConfigurable(TALENT)).toBe(false);
    expect(await caps.isConfigurable('0000aaaa-0000-4000-8000-0000000000ff')).toBe(false);
  });

  it('§5.3 RTR keeps its exact binding result (same keys, order, labels as the seeded reader)', async () => {
    const seeded = new RtrTemplateCapabilities(fakeCatalog());
    expect(await caps.listAllowedBindings(RTR)).toEqual(await seeded.listAllowedBindings(RTR));
    expect((await caps.listAllowedBindings(RTR)).map((b) => b.key)).toHaveLength(15);
  });

  it('§5.3 a sign-only type offers only the rows tagged sign (organization.*)', async () => {
    const keys = (await caps.listAllowedBindings(NDA)).map((b) => b.key);
    expect(keys).toEqual([
      'organization.name',
      'organization.address_line1',
      'organization.address_line2',
      'organization.city',
      'organization.region',
      'organization.postal_code',
      'organization.country',
    ]);
  });

  it('§5.3 an ats-only type offers every ats row; a fixed form / unconfigured type offers none', async () => {
    expect(await caps.listAllowedBindings(LEASE)).toHaveLength(15);
    expect(await caps.listAllowedBindings(I9)).toEqual([]);
    expect(await caps.listAllowedBindings(UNSET)).toEqual([]);
  });

  it('§5.3 product match is case-insensitive (pre-TP-1 uppercase rows still intersect)', async () => {
    const upper = new RtrTemplateCapabilities(
      fakeCatalog(dbCatalogRows().map((r) => ({ ...r, products: r.products.map((p) => p.toUpperCase()) }))),
      reader,
    );
    expect((await upper.listAllowedBindings(NDA)).map((b) => b.key)).toHaveLength(7);
  });

  it('§5.2 a new editable type uses rtr-html-v1: PATCH normalisation sanitises against its own catalog', async () => {
    const ok = await caps.normalizeDraftContent({
      document_type_id: NDA,
      render_schema_version: RTR_HTML_SCHEMA_V1,
      field_schema: html('<p>Between <span data-field="organization.name"></span> and the recipient.</p>'),
      existing_field_schema: null,
      requestId: 'r',
    });
    expect((ok as { html: string }).html).toContain('data-field="organization.name"');
    // talent.full_name is an ats-only row: not part of a sign-only type's catalog.
    await expect(
      caps.normalizeDraftContent({
        document_type_id: NDA,
        render_schema_version: RTR_HTML_SCHEMA_V1,
        field_schema: html('<p>For <span data-field="talent.full_name"></span>.</p>'),
        existing_field_schema: null,
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('§5.2 activation validation + sample preview work for a new editable type', async () => {
    const content = html('<p>Between <span data-field="organization.name"></span> and the recipient.</p>');
    await expect(
      caps.validateDraftContent({ document_type_id: NDA, field_schema: content, render_schema_version: RTR_HTML_SCHEMA_V1, requestId: 'r' }),
    ).resolves.toBeUndefined();
    const preview = await caps.renderSamplePreview({
      document_type_id: NDA,
      field_schema: content,
      render_schema_version: RTR_HTML_SCHEMA_V1,
      requestId: 'r',
    });
    expect(preview.html).toContain('Astre Consulting');
    expect(preview.sample_values?.map((v) => v.key)).toHaveLength(7);
    await expect(
      caps.validateDraftContent({
        document_type_id: NDA,
        field_schema: html('<p>For <span data-field="talent.full_name"></span>.</p>'),
        render_schema_version: RTR_HTML_SCHEMA_V1,
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'TEMPLATE_BINDING_UNSUPPORTED' });
  });

  it('a non-configurable type: preview refused, validation and normalisation pass through', async () => {
    await expect(
      caps.renderSamplePreview({ document_type_id: I9, field_schema: html('<p>x</p>'), render_schema_version: RTR_HTML_SCHEMA_V1, requestId: 'r' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    const raw = { anything: true };
    expect(
      await caps.normalizeDraftContent({ document_type_id: I9, render_schema_version: RTR_HTML_SCHEMA_V1, field_schema: raw, existing_field_schema: null, requestId: 'r' }),
    ).toBe(raw);
    await expect(
      caps.validateDraftContent({ document_type_id: UNSET, field_schema: raw, render_schema_version: RTR_HTML_SCHEMA_V1, requestId: 'r' }),
    ).resolves.toBeUndefined();
  });
});
