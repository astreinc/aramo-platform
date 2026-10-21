import { describe, expect, it } from 'vitest';

import { RtrTemplateCapabilities, hasAtsResolver } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RTR_BINDING_CATALOG, RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

import { fakeCatalog, seededRtrCatalogRows } from './fixtures/rtr-seed-catalog.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — the RTR template-content capability (Insert-field catalog §15,
// closed-binding validation §14, fixed-sample preview §17). RTR is the only configurable
// type; others are no-op/empty.
// DOC-TEMPLATE-LIB-1 T-2 — the allowed bindings are read from the Aramo TemplateVariable
// catalog (here an in-memory reader holding the 8 seeded rows); behaviour for those 8
// keys is identical to the former code catalog.

const RTR = RIGHT_TO_REPRESENT_TYPE_ID;
const OTHER = '00000000-0000-0000-0000-0000000000ff';
const caps = new RtrTemplateCapabilities(fakeCatalog());

function input(blocks: Array<{ type: string; text: string }>, title = 'Right to Represent') {
  return {
    document_type_id: RTR,
    field_schema: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title, blocks },
    render_schema_version: RTR_GENERATED_SCHEMA_V1,
    requestId: 'r',
  };
}
async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'NO_THROW';
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE';
  }
}

describe('RtrTemplateCapabilities (T1 port)', () => {
  it('isConfigurable: only RTR', () => {
    expect(caps.isConfigurable(RTR)).toBe(true);
    expect(caps.isConfigurable(OTHER)).toBe(false);
  });

  // Slice 1 B3 adds requisition.description ("Job description"); Amendment A2 adds
  // talent.desired_pay_rate ("Desired pay rate") → 8 bindings.
  it('listAllowedBindings: the 8 RTR bindings (labels+groups); empty for non-configurable', async () => {
    const b = await caps.listAllowedBindings(RTR);
    expect(b.map((x) => x.key)).toEqual([
      'talent.full_name',
      'talent.desired_pay_rate',
      'client.name',
      'requisition.title',
      'requisition.reference',
      'requisition.description',
      'recruiting_company.name',
      'recruiter.display_name',
    ]);
    expect(b.every((x) => x.label.length > 0 && x.group.length > 0)).toBe(true);
    expect(b.find((x) => x.key === 'talent.desired_pay_rate')).toEqual({ key: 'talent.desired_pay_rate', label: 'Desired pay rate', group: 'Talent' });
    expect(b.some((x) => x.key.startsWith('agreed_pay_rate') || /agreed/i.test(x.label))).toBe(false);
    expect(b.find((x) => x.key === 'requisition.description')).toEqual({ key: 'requisition.description', label: 'Job description', group: 'Requisition' });
    expect(await caps.listAllowedBindings(OTHER)).toEqual([]);
  });

  it('validateDraftContent: valid passes; non-configurable type is a no-op', async () => {
    expect(await codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }])))).toBe('NO_THROW');
    expect(await codeOf(() => caps.validateDraftContent({ document_type_id: OTHER, field_schema: {}, render_schema_version: 'x', requestId: 'r' }))).toBe('NO_THROW');
  });

  it('validateDraftContent: unknown binding → TEMPLATE_BINDING_UNSUPPORTED (agreed-pay is not in the catalog)', async () => {
    expect(await codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: '{{agreed_pay_rate.amount}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
    expect(await codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: '{{talent.email}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });

  it('validateDraftContent: empty content / blank title → VALIDATION_ERROR', async () => {
    expect(await codeOf(() => caps.validateDraftContent(input([])))).toBe('VALIDATION_ERROR');
    expect(await codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: 'x' }], '')))).toBe('VALIDATION_ERROR');
  });

  it('renderSamplePreview: substitutes fixed sample values (validates first)', async () => {
    const p = await caps.renderSamplePreview(
      input([{ type: 'TEXT', text: '{{talent.full_name}} / {{client.name}} / {{requisition.reference}} / {{recruiter.display_name}}' }]),
    );
    expect(p.blocks[0]!.text).toBe('Ravi Shankar / Mindlance / REQ-1001 / Deepika Rao');
    expect(p.title).toBe('Right to Represent');
    // Slice 1 B2 — the fixed signature block, PRINTED NAME = the talent.full_name sample.
    expect(p.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
  });

  it('renderSamplePreview: Desired pay rate uses the fixed sample $70/hr (A2), Job description its sample (B3)', async () => {
    const p = await caps.renderSamplePreview(input([{ type: 'TEXT', text: 'Rate {{talent.desired_pay_rate}}. {{requisition.description}}' }]));
    expect(p.blocks[0]?.text.startsWith('Rate $70/hr. Analyze business requirements')).toBe(true);
  });

  it('renderSamplePreview: refuses unknown binding (never previews a non-catalog token)', async () => {
    expect(await codeOf(() => caps.renderSamplePreview(input([{ type: 'TEXT', text: '{{agreed_pay_rate.amount}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });
});

describe('DOC-TEMPLATE-LIB-1 T-2 — catalog-driven allowed bindings', () => {
  it('the seeded catalog yields exactly the former code catalog (keys, order, labels, groups, samples)', async () => {
    const b = await caps.listAllowedBindings(RTR);
    expect(b).toEqual(RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, group: d.group })));
    const p = await caps.renderSamplePreview(input([{ type: 'TEXT', text: 'x' }]));
    expect(p.sample_values).toEqual(RTR_BINDING_CATALOG.map((d) => ({ key: d.key, label: d.label, value: d.sample })));
  });

  it('a label / sample edited in the catalog is what the editor and preview show', async () => {
    const rows = seededRtrCatalogRows().map((r) =>
      r.key === 'client.name' ? { ...r, label: 'Client company', sample_value: 'Acme Corp' } : r,
    );
    const c = new RtrTemplateCapabilities(fakeCatalog(rows));
    expect((await c.listAllowedBindings(RTR)).find((x) => x.key === 'client.name')?.label).toBe('Client company');
    const p = await c.renderSamplePreview(input([{ type: 'TEXT', text: 'For {{client.name}}' }]));
    expect(p.blocks[0]?.text).toBe('For Acme Corp');
  });

  it('an INACTIVE catalog key is not offered and is rejected', async () => {
    const rows = seededRtrCatalogRows().map((r) => (r.key === 'client.name' ? { ...r, active: false } : r));
    const c = new RtrTemplateCapabilities(fakeCatalog(rows));
    expect((await c.listAllowedBindings(RTR)).map((x) => x.key)).not.toContain('client.name');
    expect(await codeOf(() => c.validateDraftContent(input([{ type: 'TEXT', text: '{{client.name}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });

  it('a catalog key WITHOUT an apps/api resolver fails closed (not offered; rejected reason no_resolver)', async () => {
    const at = new Date();
    const rows = [
      ...seededRtrCatalogRows(),
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        key: 'organization.address_line1',
        label: 'Address line 1',
        group_label: 'Organization',
        data_type: 'TEXT',
        products: ['ATS'],
        ats_binding_key: 'organization.address_line1',
        sample_value: '1 Main St',
        active: true,
        created_at: at,
        updated_at: at,
      },
    ];
    const c = new RtrTemplateCapabilities(fakeCatalog(rows));
    expect((await c.listAllowedBindings(RTR)).map((x) => x.key)).not.toContain('organization.address_line1');
    let err: { code?: string; context?: { details?: Record<string, unknown> } } | undefined;
    try {
      await c.validateDraftContent(input([{ type: 'TEXT', text: '{{organization.address_line1}}' }]));
    } catch (e) {
      err = e as typeof err;
    }
    expect(err?.code).toBe('TEMPLATE_BINDING_UNSUPPORTED');
    expect(err?.context?.details).toEqual({ binding_key: 'organization.address_line1', reason: 'no_resolver' });
  });

  it('a row without an ats_binding_key is not an ATS binding (RTR is an ATS document type)', async () => {
    const rows = seededRtrCatalogRows().map((r) => (r.key === 'recruiter.display_name' ? { ...r, ats_binding_key: null } : r));
    const c = new RtrTemplateCapabilities(fakeCatalog(rows));
    expect((await c.listAllowedBindings(RTR)).map((x) => x.key)).not.toContain('recruiter.display_name');
  });

  it('hasAtsResolver: resolver key AND key === ats_binding_key', () => {
    expect(hasAtsResolver({ key: 'talent.full_name', ats_binding_key: 'talent.full_name' })).toBe(true);
    expect(hasAtsResolver({ key: 'talent.name', ats_binding_key: 'talent.full_name' })).toBe(false);
    expect(hasAtsResolver({ key: 'talent.full_name', ats_binding_key: null })).toBe(false);
    expect(hasAtsResolver({ key: 'x.y', ats_binding_key: 'x.y' })).toBe(false);
  });
});
