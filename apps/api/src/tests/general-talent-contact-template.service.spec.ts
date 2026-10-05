import { describe, it, expect } from 'vitest';
import { AramoError } from '@aramo/common';
import type { EmailTemplateRepository, EmailTemplateRow } from '@aramo/communications';

import { EmailTemplateService } from '../communications/email-template.service.js';
import { SystemRequisitionContactTemplateService } from '../communications/system-requisition-contact-template.service.js';
import {
  SystemGeneralTalentContactTemplateService,
  SYSTEM_GENERAL_TALENT_CONTACT_TEMPLATE_ID,
} from '../communications/system-general-talent-contact-template.service.js';

// COMM-RECRUITER-W1 (W1-A1) — the General Talent Contact category did not exist at
// baseline 44cc7f90 (EmailTemplateCategory had exactly requisition_initial_contact),
// so every assertion below was unrunnable (honest RED).

function makeService(overrides: EmailTemplateRow[] = []): { svc: EmailTemplateService; created: unknown[] } {
  const created: unknown[] = [];
  const repo = {
    listByTenant: async () => overrides,
    findActiveByKey: async () => null,
    findByIdForTenant: async () => null,
    async create(args: Record<string, unknown>) {
      created.push(args);
      return {
        id: 'row-1',
        tenant_id: args['tenant_id'],
        template_key: args['template_key'],
        category: args['category'],
        name: args['name'],
        subject_template: args['subject_template'],
        body_template: args['body_template'],
        is_active: true,
        created_at: new Date(0),
        updated_at: new Date(0),
      } as EmailTemplateRow;
    },
    update: async () => null,
    deactivate: async () => false,
  } as unknown as EmailTemplateRepository;
  const svc = new EmailTemplateService(
    repo,
    new SystemRequisitionContactTemplateService(),
    new SystemGeneralTalentContactTemplateService(),
  );
  return { svc, created };
}

const REQ = 'req-id';

describe('W1-A1 — General Talent Contact template', () => {
  it('list() surfaces BOTH governed system defaults (requisition + general talent contact)', async () => {
    const { svc } = makeService();
    const views = await svc.list('tenant-1');
    const byCategory = new Map(views.map((v) => [v.category, v]));
    const general = byCategory.get('talent_general_contact');
    expect(general).toBeDefined();
    expect(general?.id).toBeNull();
    expect(general?.is_system_default).toBe(true);
    expect(general?.template_key).toBe('talent-general-contact');
    expect(byCategory.get('requisition_initial_contact')).toBeDefined();
  });

  it('the general default is gender-neutral (no gendered pronoun) and requisition-free', async () => {
    const d = new SystemGeneralTalentContactTemplateService().resolveDefault({
      talent_first_name: 'John',
      recruiter_display_name: 'Purush',
      tenant_recruiting_company_name: 'Astre Consulting',
    });
    expect(d.template_id).toBe(SYSTEM_GENERAL_TALENT_CONTACT_TEMPLATE_ID);
    const combined = `${d.subject}\n${d.body}`;
    expect(combined).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
    // requisition-free: no residual merge markup, no requisition facts
    expect(combined).not.toMatch(/\{\{|\}\}/);
    expect(combined.toLowerCase()).not.toContain('requisition');
    expect(d.warnings).toEqual([]); // every field present → no omission warning
  });

  it('REJECTS a requisition-only token in a General Talent Contact override (fails closed 422)', async () => {
    const { svc, created } = makeService();
    await expect(
      svc.create(
        'tenant-1',
        'actor-1',
        {
          category: 'talent_general_contact',
          name: 'My general note',
          subject_template: 'Hi {{talent.first_name}}',
          body_template: 'Re {{requisition.title}} from {{company.name}}',
        },
        REQ,
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_TEMPLATE_INVALID_MERGE_TOKEN', statusCode: 422 });
    expect(created).toHaveLength(0); // never persisted
  });

  it('ACCEPTS a General Talent Contact override using only the 3 allowed tokens', async () => {
    const { svc, created } = makeService();
    const view = await svc.create(
      'tenant-1',
      'actor-1',
      {
        category: 'talent_general_contact',
        name: 'My general template',
        subject_template: '{{company.name}} opportunities',
        body_template: 'Hi {{talent.first_name}}, — {{recruiter.display_name}}',
      },
      REQ,
    );
    expect(view.template_key).toBe('talent-general-contact');
    expect(created).toHaveLength(1);
    expect((created[0] as { template_key: string }).template_key).toBe('talent-general-contact');
  });

  it('does not regress requisition-contact validation (its full token set still allowed)', async () => {
    const { svc, created } = makeService();
    await svc.create(
      'tenant-1',
      'actor-1',
      {
        category: 'requisition_initial_contact',
        name: 'Req override',
        subject_template: '{{requisition.title}} | {{requisition.location}}',
        body_template: 'Hi {{talent.first_name}} re {{role.summary_excerpt}}',
      },
      REQ,
    );
    expect(created).toHaveLength(1);
    expect((created[0] as { template_key: string }).template_key).toBe('requisition-contact');
  });
});
