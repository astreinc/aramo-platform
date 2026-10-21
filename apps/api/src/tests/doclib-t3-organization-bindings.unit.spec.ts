import { readFileSync } from 'node:fs';

import { AramoError } from '@aramo/common';
import { describe, expect, it } from 'vitest';

import { RIGHT_TO_REPRESENT_TYPE_ID } from '../rtr/rtr-constants.js';
import { RtrTemplateBindingService, organizationName } from '../rtr/rtr-template-binding.service.js';
import {
  DEFAULT_RTR_TEMPLATE_CONTENT_V1,
  RTR_BINDING_CATALOG,
  RTR_GENERATED_SCHEMA_V1,
  isRtrBindingKey,
} from '../rtr/rtr-template-content.js';

// DOC-TEMPLATE-LIB-1 T-3 (§4.3) — the organization.* catalog variables: resolved from the
// tenant profile (TenantRepository.findBrandingById), fail closed when blank, and kept in
// parity with the TemplateVariable seed migration. Also carries the RTR-TEMPLATE-1
// type-id hand-sync guard formerly in platform-admin (rtr-template-type-id-drift), now
// pointed at the Aramo RTR default: the T-3 conversion migration's RTR type id must equal
// the apps/api constant and the doc5-seeded DocumentType.

const MIGRATIONS = new URL('../../../../libs/documents/prisma/migrations/', import.meta.url);
const read = (dir: string): string => readFileSync(new URL(`${dir}/migration.sql`, MIGRATIONS), 'utf8');

const PROFILE = {
  name: 'acme-ws',
  display_name: 'Acme Branding',
  legal_name: 'Acme LLC',
  logo_url: null,
  address_line1: '1 Main St',
  address_line2: null,
  city: 'Iselin',
  state_province: 'NJ',
  postal_code: '08830',
  country_code: 'US',
};

function svc(profile: Record<string, unknown> | null): RtrTemplateBindingService {
  const talent = { findById: async () => ({ first_name: 'Ravi', last_name: 'Shankar' }) };
  const tenants = { findBrandingById: async () => profile, findLegalNameById: async () => null };
  return new RtrTemplateBindingService(talent as never, {} as never, {} as never, tenants as never, {} as never);
}

async function bindText(binding: RtrTemplateBindingService, text: string): Promise<string> {
  const m = await binding.bind({
    content: { render_schema_version: RTR_GENERATED_SCHEMA_V1, title: 'RTR', blocks: [{ type: 'TEXT', text }] },
    template_version_id: 'v-1',
    tenant_id: 't-1',
    talent_id: 'tal-1',
    requisition_id: 'req-1',
    company_id: 'co-1',
    recruiter_user_id: 'u-1',
    requestId: 'rq-1',
  });
  return m.blocks[0]?.text ?? '';
}

describe('DOC-TEMPLATE-LIB-1 T-3 — organization.* bindings', () => {
  it('resolves name + address from the tenant profile', async () => {
    const text = await bindText(
      svc(PROFILE),
      '{{organization.name}} | {{organization.address_line1}} | {{organization.city}}, {{organization.region}} {{organization.postal_code}} {{organization.country}}',
    );
    expect(text).toBe('Acme Branding | 1 Main St | Iselin, NJ 08830 US');
  });

  it('organization.name falls back display_name → legal_name → workspace name', async () => {
    expect(await bindText(svc({ ...PROFILE, display_name: ' ' }), '{{organization.name}}')).toBe('Acme LLC');
    expect(await bindText(svc({ ...PROFILE, display_name: null, legal_name: null }), '{{organization.name}}')).toBe('acme-ws');
    expect(organizationName(null)).toBeNull();
  });

  it('a blank address field fails closed (RTR_TEMPLATE_BINDING_MISSING), never an empty substitution', async () => {
    for (const key of ['organization.address_line2', 'organization.city']) {
      try {
        await bindText(svc({ ...PROFILE, city: '  ' }), `{{${key}}}`);
        throw new Error('expected a fail-closed refusal');
      } catch (e) {
        expect(e).toBeInstanceOf(AramoError);
        expect((e as AramoError).code).toBe('RTR_TEMPLATE_BINDING_MISSING');
      }
    }
    await expect(bindText(svc(null), '{{organization.name}}')).rejects.toMatchObject({ code: 'RTR_TEMPLATE_BINDING_MISSING' });
  });

  it('the tenant-profile read is memoized (one read for many organization keys)', async () => {
    let reads = 0;
    const tenants = { findBrandingById: async () => (reads++, PROFILE), findLegalNameById: async () => null };
    const b = new RtrTemplateBindingService(
      { findById: async () => ({ first_name: 'R', last_name: 'S' }) } as never,
      {} as never,
      {} as never,
      tenants as never,
      {} as never,
    );
    await bindText(b, '{{organization.city}} {{organization.region}} {{organization.country}}');
    expect(reads).toBe(1);
  });

  it('TemplateVariable seed migration ↔ RTR_BINDING_CATALOG parity for the organization keys', () => {
    const sql = read('20261021140000_doclib_t3_organization_template_variables');
    const rows = [...sql.matchAll(/\(gen_random_uuid\(\), '([^']+)', '([^']+)', '([^']+)', 'TEXT', ARRAY\['ATS', 'SIGN'\], '([^']+)', '([^']+)'\)/g)];
    const org = RTR_BINDING_CATALOG.filter((d) => d.key.startsWith('organization.'));
    expect(rows.map((r) => r[1])).toEqual(org.map((d) => d.key));
    for (const [, key, label, group, binding, sample] of rows) {
      const d = org.find((x) => x.key === key);
      expect(d).toBeDefined();
      expect(label).toBe(d?.label);
      expect(group).toBe(d?.group);
      expect(binding).toBe(key);
      expect(sample).toBe(d?.sample);
      expect(isRtrBindingKey(key as string)).toBe(true);
    }
  });

  it('the T-3 conversion migration embeds the default RTR content and the seeded RTR type id', () => {
    const sql = read('20261021140100_doclib_t3_rtr_platform_default');
    const json = sql.match(/'(\{"render_schema_version".*?\})'::jsonb/s);
    expect(json).not.toBeNull();
    expect(JSON.parse(json?.[1] ?? '{}')).toEqual(DEFAULT_RTR_TEMPLATE_CONTENT_V1);
    const typeId = sql.match(/c_rtr CONSTANT UUID := '([0-9a-f-]{36})'/)?.[1];
    expect(typeId).toBe(RIGHT_TO_REPRESENT_TYPE_ID);
    const seeded = read('20260923170000_doc5_seed_rtr_document_type').match(/'([0-9a-fA-F-]{36})',\s*NULL,\s*'RIGHT_TO_REPRESENT'/)?.[1];
    expect(seeded).toBe(RIGHT_TO_REPRESENT_TYPE_ID);
  });
});
