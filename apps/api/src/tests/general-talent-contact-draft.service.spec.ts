import { describe, it, expect } from 'vitest';
import type { IdentityRepository } from '@aramo/identity';
import type { TalentRecordRepository } from '@aramo/talent-record';

import { GeneralTalentContactDraftService } from '../communications/general-talent-contact-draft.service.js';
import { SystemGeneralTalentContactTemplateService } from '../communications/system-general-talent-contact-template.service.js';
import { TalentContactContextError } from '../communications/talent-contact-context.error.js';
import type { EmailTemplateResolverService } from '../communications/email-template-resolver.service.js';
import type { EmailRecipientResolver } from '../microsoft/email-recipient-resolver.port.js';

// COMM-RECRUITER-W1 (W1-A2) — the Talent-only draft did not exist at baseline
// 44cc7f90 (every Talent email flow was requisition-bound). Honest RED.

const TALENT = '00000000-0000-0000-0000-0000000000aa';

function makeService(opts: {
  talent?: { first_name: string; last_name: string } | null;
  resolveSource?: EmailTemplateResolverService['resolveSource'];
}): GeneralTalentContactDraftService {
  const recipients = {
    resolveRecipientEmail: async () => 'john@example.com',
  } as unknown as EmailRecipientResolver;
  const talents = {
    findById: async () => (opts.talent === undefined ? { first_name: 'John', last_name: 'Doe' } : opts.talent),
  } as unknown as TalentRecordRepository;
  const identity = {
    findUserById: async () => ({ display_name: 'Purush' }),
    findTenantNameById: async () => ({ display_name: 'Astre Consulting', name: 'astre' }),
  } as unknown as IdentityRepository;
  const templateResolver = {
    resolveSource:
      opts.resolveSource ??
      (async () => ({ source: 'system_default' as const, template_key: 'talent-general-contact' })),
  } as unknown as EmailTemplateResolverService;
  return new GeneralTalentContactDraftService(
    recipients,
    talents,
    identity,
    new SystemGeneralTalentContactTemplateService(),
    templateResolver,
  );
}

describe('W1-A2 — General Talent Contact draft (no requisition)', () => {
  it('prepares a governed draft with NO requisition; recipient server-owned + display-only', async () => {
    const svc = makeService({});
    const draft = await svc.prepareDraft({ tenant_id: 't1', recruiter_id: 'r1', talent_record_id: TALENT });
    expect(draft.to.editable).toBe(false);
    expect(draft.to.email).toBe('john@example.com');
    expect(draft.context.template_key).toBe('talent-general-contact');
    expect(draft.context.template_id).toBe('system.talent-general-contact.v1');
    expect(draft.subject).toContain('Astre Consulting');
    expect(draft.body).toContain('Hi John,');
    // requisition-free + gender-neutral
    expect(`${draft.subject}\n${draft.body}`).not.toMatch(/\b(he|she|him|her|his|hers)\b/i);
    expect(`${draft.subject}\n${draft.body}`.toLowerCase()).not.toContain('requisition');
  });

  it('fails closed (talent_not_found) when the Talent is absent/cross-tenant', async () => {
    const svc = makeService({ talent: null });
    await expect(
      svc.prepareDraft({ tenant_id: 't1', recruiter_id: 'r1', talent_record_id: TALENT }),
    ).rejects.toBeInstanceOf(TalentContactContextError);
  });

  it('tenant override wins over the code default (server-resolved, no client choice)', async () => {
    const svc = makeService({
      resolveSource: async () => ({
        source: 'tenant_override' as const,
        template_id: 'override-row-1',
        template_key: 'talent-general-contact',
        subject_template: '{{company.name}} — a note',
        body_template: 'Hi {{talent.first_name}}, from {{recruiter.display_name}}',
      }),
    });
    const draft = await svc.prepareDraft({ tenant_id: 't1', recruiter_id: 'r1', talent_record_id: TALENT });
    expect(draft.subject).toBe('Astre Consulting — a note');
    expect(draft.body).toBe('Hi John, from Purush');
    expect(draft.context.template_id).toBe('override-row-1');
  });
});
