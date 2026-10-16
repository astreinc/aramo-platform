import { describe, expect, it } from 'vitest';

import { RtrTemplateBindingService, flattenToPlainText, formatDesiredPayRate } from '../rtr/rtr-template-binding.service.js';
import { RTR_GENERATED_SCHEMA_V1, type RtrTemplateContentV1 } from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-ADMIN-RTR-1 T2b (§53) — authoritative RTR binding resolvers. Each shipped
// binding resolves from its authoritative source; a missing value fails CLOSED
// (RTR_TEMPLATE_BINDING_MISSING, 422) — never substituted, blanked, or inferred.
// agreed_pay_rate.* is NOT in the catalog (§13 exclusion) and is never resolvable.
// Gate-0 rulings proven: requisition.reference=REQ-{requisition_number}; recruiter.display_name
// = the SENDING recruiter (recruiter_user_id).

const TENANT = 't-1';
const TALENT = 'tal-1';
const REQ = 'req-1';
const COMPANY = 'co-1';
const SENDER = 'user-send';

function svc(over: {
  talent?: { first_name: string; last_name: string; desired_pay?: string | null } | null;
  requisition?: { title: string; requisition_number: number; description?: string | null } | null;
  companyName?: string | null;
  tenantName?: string | null;
  senderDisplayName?: string | null;
} = {}): RtrTemplateBindingService {
  const talent = {
    findById: async () => (over.talent === undefined ? { first_name: 'Ravi', last_name: 'Shankar', desired_pay: '70/hr' } : over.talent),
  };
  const requisitions = {
    findByIdAdmin: async () =>
      over.requisition === undefined
        ? {
            title: 'Business Analyst - Multi-Family',
            requisition_number: 1001,
            company_id: COMPANY,
            description: '<p>Analyze <b>requirements</b>.</p><ul><li>Own scope</li><li>Write AC</li></ul>',
          }
        : over.requisition,
  };
  const companies = {
    findNamesByIds: async (a: { ids: readonly string[] }) =>
      new Map<string, string>(over.companyName === null ? [] : [[a.ids[0] as string, over.companyName ?? 'Mindlance']]),
  };
  // PO ruling 2026-10-16 — recruiting_company.name reads Tenant.legal_name only.
  // findNamesByIds (the workspace name) is present but must NEVER be consulted.
  const tenants = {
    findLegalNameById: async () => (over.tenantName === null ? null : (over.tenantName ?? 'Astre Consulting Services Inc.')),
    findNamesByIds: async () => {
      throw new Error('workspace Tenant.name must not be read for recruiting_company.name');
    },
  };
  const identity = { findUserById: async () => (over.senderDisplayName === null ? null : { display_name: over.senderDisplayName ?? 'Deepika Rao' }) };
  return new RtrTemplateBindingService(talent as never, requisitions as never, companies as never, tenants as never, identity as never);
}

function content(token: string): RtrTemplateContentV1 {
  return { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'RTR', blocks: [{ type: 'TEXT', text: `Value: ${token}` }] };
}

async function resolveText(binding: RtrTemplateBindingService, token: string): Promise<string> {
  const model = await binding.bind({
    content: content(token),
    template_version_id: 'tv-1',
    tenant_id: TENANT,
    talent_id: TALENT,
    requisition_id: REQ,
    company_id: COMPANY,
    recruiter_user_id: SENDER,
    requestId: 'r',
  });
  return (model.blocks[0] as { text: string }).text;
}

describe('RTR binding resolvers (T2b, §53)', () => {
  it('resolves every shipped binding from its authoritative source', async () => {
    const b = svc();
    expect(await resolveText(b, '{{talent.full_name}}')).toBe('Value: Ravi Shankar');
    expect(await resolveText(b, '{{client.name}}')).toBe('Value: Mindlance');
    expect(await resolveText(b, '{{requisition.title}}')).toBe('Value: Business Analyst - Multi-Family');
    expect(await resolveText(b, '{{requisition.reference}}')).toBe('Value: REQ-1001'); // requisition_number, NOT external_req_id
    expect(await resolveText(b, '{{recruiting_company.name}}')).toBe('Value: Astre Consulting Services Inc.'); // Tenant.legal_name
    expect(await resolveText(b, '{{recruiter.display_name}}')).toBe('Value: Deepika Rao'); // the SENDER
  });

  it('fails CLOSED (RTR_TEMPLATE_BINDING_MISSING) when an authoritative value is missing — never substituted', async () => {
    await expect(resolveText(svc({ talent: null }), '{{talent.full_name}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
    await expect(resolveText(svc({ companyName: null }), '{{client.name}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
    await expect(resolveText(svc({ requisition: null }), '{{requisition.title}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
    await expect(resolveText(svc({ requisition: null }), '{{requisition.reference}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
    await expect(resolveText(svc({ tenantName: null }), '{{recruiting_company.name}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
    await expect(resolveText(svc({ senderDisplayName: null }), '{{recruiter.display_name}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
  });

  it('agreed_pay_rate.* is EXCLUDED from the catalog — rejected as an unknown binding, never resolved to any pay value', async () => {
    await expect(resolveText(svc(), '{{agreed_pay_rate.amount}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_CONFIGURATION_INVALID' });
  });

  it('recruiter.display_name resolves the SENDER (the recruiter_user_id passed to the user read)', async () => {
    let seenUserId = '';
    const identity = {
      findUserById: async (uid: string) => {
        seenUserId = uid;
        return { display_name: 'Deepika Rao' };
      },
    };
    const b = new RtrTemplateBindingService(
      { findById: async () => ({ first_name: 'R', last_name: 'S' }) } as never,
      { findByIdAdmin: async () => ({ title: 'T', requisition_number: 1, company_id: COMPANY }) } as never,
      { findNamesByIds: async () => new Map() } as never,
      { findLegalNameById: async () => null } as never,
      identity as never,
    );
    await b.bind({
      content: content('{{recruiter.display_name}}'),
      template_version_id: 'tv',
      tenant_id: TENANT,
      talent_id: TALENT,
      requisition_id: REQ,
      company_id: COMPANY,
      recruiter_user_id: SENDER,
      requestId: 'r',
    });
    expect(seenUserId).toBe(SENDER);
  });

  it('recruiting_company.name fails CLOSED when Tenant.legal_name is blank — never falls back to the workspace/display name', async () => {
    await expect(resolveText(svc({ tenantName: '   ' }), '{{recruiting_company.name}}')).rejects.toMatchObject({
      code: 'RTR_TEMPLATE_BINDING_MISSING',
      context: { details: { binding_key: 'recruiting_company.name' } },
    });
  });

  // Slice 1 B3 — requisition.description ("Job description"): the exact Requisition's
  // description flattened to plain text (markup stripped, paragraph breaks kept).
  it('requisition.description resolves the requisition description as plain text with paragraph breaks', async () => {
    expect(await resolveText(svc(), '{{requisition.description}}')).toBe('Value: Analyze requirements.\n\n\u2022 Own scope\n\u2022 Write AC');
  });

  it('requisition.description fails CLOSED when null, blank, or markup-only', async () => {
    for (const description of [null, '', '   ', '<p> </p><br/>']) {
      await expect(
        resolveText(svc({ requisition: { title: 'T', requisition_number: 1, description } }), '{{requisition.description}}'),
      ).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING', context: { details: { binding_key: 'requisition.description' } } });
    }
  });

  it('flattenToPlainText strips tags, decodes basic entities, normalises whitespace, keeps paragraph breaks', () => {
    expect(flattenToPlainText('Line\tone   here\r\nLine two')).toBe('Line one here\nLine two');
    expect(flattenToPlainText('<h2>Role</h2><p>A &amp; B&nbsp;&lt;team&gt;</p><script>x</script>')).toBe('Role\n\nA & B <team>\n\nx');
    expect(flattenToPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
    expect(flattenToPlainText('one<br>two<br/>three')).toBe('one\ntwo\nthree');
  });

  // Slice 1 B2 — the fixed signature block's PRINTED NAME is the bound talent.full_name for
  // every version, even when the content never references {{talent.full_name}}.
  it('bind() always resolves the signature-block printed name (talent.full_name), and fails closed without it', async () => {
    const model = await svc().bind({
      content: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'RTR', blocks: [{ type: 'TEXT', text: 'No tokens here.' }] },
      template_version_id: 'tv',
      tenant_id: TENANT,
      talent_id: TALENT,
      requisition_id: REQ,
      company_id: COMPANY,
      recruiter_user_id: SENDER,
      requestId: 'r',
    });
    expect(model.signature_block).toEqual({ printed_name: 'Ravi Shankar' });
    await expect(
      svc({ talent: null }).bind({
        content: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'RTR', blocks: [{ type: 'TEXT', text: 'No tokens.' }] },
        template_version_id: 'tv',
        tenant_id: TENANT,
        talent_id: TALENT,
        requisition_id: REQ,
        company_id: COMPANY,
        recruiter_user_id: SENDER,
        requestId: 'r',
      }),
    ).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
  });

  // Amendment A2 — talent.desired_pay_rate: TalentRecord.desired_pay as recorded, `$` rule,
  // fail closed when blank. The talent's STATED desired rate — never agreed_pay_rate.*.
  it('talent.desired_pay_rate resolves TalentRecord.desired_pay with the leading-$ rule', async () => {
    expect(await resolveText(svc(), '{{talent.desired_pay_rate}}')).toBe('Value: $70/hr');
    expect(await resolveText(svc({ talent: { first_name: 'R', last_name: 'S', desired_pay: '.5k/mo' } }), '{{talent.desired_pay_rate}}')).toBe('Value: $.5k/mo');
  });

  it('talent.desired_pay_rate passes an already-currency value through unchanged', async () => {
    for (const v of ['$85/hr', 'USD 85/hr', 'INR 1,00,000 / month']) {
      expect(await resolveText(svc({ talent: { first_name: 'R', last_name: 'S', desired_pay: `  ${v} ` } }), '{{talent.desired_pay_rate}}')).toBe(`Value: ${v}`);
    }
  });

  it('talent.desired_pay_rate fails CLOSED when blank/null — never substituted from any other pay', async () => {
    for (const desired_pay of [null, '', '   ']) {
      await expect(
        resolveText(svc({ talent: { first_name: 'R', last_name: 'S', desired_pay } }), '{{talent.desired_pay_rate}}'),
      ).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING', context: { details: { binding_key: 'talent.desired_pay_rate' } } });
    }
    expect(formatDesiredPayRate(null)).toBeNull();
    // agreed_pay_rate.* stays excluded — still an unknown binding.
    await expect(resolveText(svc(), '{{agreed_pay_rate.amount}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_CONFIGURATION_INVALID' });
  });
});
