import { describe, expect, it } from 'vitest';

import { RtrTemplateBindingService } from '../rtr/rtr-template-binding.service.js';
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
  talent?: { first_name: string; last_name: string } | null;
  requisition?: { title: string; requisition_number: number } | null;
  companyName?: string | null;
  tenantName?: string | null;
  senderDisplayName?: string | null;
} = {}): RtrTemplateBindingService {
  const talent = { findById: async () => (over.talent === undefined ? { first_name: 'Ravi', last_name: 'Shankar' } : over.talent) };
  const requisitions = {
    findByIdAdmin: async () =>
      over.requisition === undefined
        ? { title: 'Business Analyst - Multi-Family', requisition_number: 1001, company_id: COMPANY }
        : over.requisition,
  };
  const companies = {
    findNamesByIds: async (a: { ids: readonly string[] }) =>
      new Map<string, string>(over.companyName === null ? [] : [[a.ids[0] as string, over.companyName ?? 'Mindlance']]),
  };
  const tenants = {
    findNamesByIds: async (ids: string[]) =>
      new Map<string, string>(over.tenantName === null ? [] : [[ids[0] as string, over.tenantName ?? 'Astre Consulting']]),
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
    expect(await resolveText(b, '{{recruiting_company.name}}')).toBe('Value: Astre Consulting');
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
      { findNamesByIds: async () => new Map() } as never,
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
});
