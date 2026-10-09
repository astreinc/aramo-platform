import { describe, expect, it } from 'vitest';

import { RtrTemplateCapabilities } from '../rtr/rtr-template-capabilities.service.js';
import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RTR_GENERATED_SCHEMA_V1 } from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-ADMIN-RTR-1 — the RTR template-content capability (Insert-field catalog §15,
// closed-binding validation §14, fixed-sample preview §17). RTR is the only configurable
// type; others are no-op/empty.

const RTR = RIGHT_TO_REPRESENT_TYPE_ID;
const OTHER = '00000000-0000-0000-0000-0000000000ff';
const caps = new RtrTemplateCapabilities();

function input(blocks: Array<{ type: string; text: string }>, title = 'Right to Represent') {
  return {
    document_type_id: RTR,
    field_schema: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title, blocks },
    render_schema_version: RTR_GENERATED_SCHEMA_V1,
    requestId: 'r',
  };
}
function codeOf(fn: () => void): string {
  try {
    fn();
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

  it('listAllowedBindings: the 6 RTR bindings (labels+groups); empty for non-configurable', () => {
    const b = caps.listAllowedBindings(RTR);
    expect(b.map((x) => x.key)).toEqual([
      'talent.full_name',
      'client.name',
      'requisition.title',
      'requisition.reference',
      'recruiting_company.name',
      'recruiter.display_name',
    ]);
    expect(b.every((x) => x.label.length > 0 && x.group.length > 0)).toBe(true);
    expect(caps.listAllowedBindings(OTHER)).toEqual([]);
  });

  it('validateDraftContent: valid passes; non-configurable type is a no-op', () => {
    expect(codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: 'Hi {{talent.full_name}}' }])))).toBe('NO_THROW');
    expect(codeOf(() => caps.validateDraftContent({ document_type_id: OTHER, field_schema: {}, render_schema_version: 'x', requestId: 'r' }))).toBe('NO_THROW');
  });

  it('validateDraftContent: unknown binding → TEMPLATE_BINDING_UNSUPPORTED (agreed-pay is not in the catalog)', () => {
    expect(codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: '{{agreed_pay_rate.amount}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
    expect(codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: '{{talent.email}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });

  it('validateDraftContent: empty content / blank title → VALIDATION_ERROR', () => {
    expect(codeOf(() => caps.validateDraftContent(input([])))).toBe('VALIDATION_ERROR');
    expect(codeOf(() => caps.validateDraftContent(input([{ type: 'TEXT', text: 'x' }], '')))).toBe('VALIDATION_ERROR');
  });

  it('renderSamplePreview: substitutes fixed sample values (validates first)', () => {
    const p = caps.renderSamplePreview(
      input([{ type: 'TEXT', text: '{{talent.full_name}} / {{client.name}} / {{requisition.reference}} / {{recruiter.display_name}}' }]),
    );
    expect(p.blocks[0]!.text).toBe('Ravi Shankar / Mindlance / REQ-1001 / Deepika Rao');
    expect(p.title).toBe('Right to Represent');
  });

  it('renderSamplePreview: refuses unknown binding (never previews a non-catalog token)', () => {
    expect(codeOf(() => caps.renderSamplePreview(input([{ type: 'TEXT', text: '{{agreed_pay_rate.amount}}' }])))).toBe('TEMPLATE_BINDING_UNSUPPORTED');
  });
});
