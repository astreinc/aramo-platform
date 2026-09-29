import { describe, it, expect } from 'vitest';

import type { ResolvedTemplateSource } from '../communications/email-template-resolver.service.js';
import {
  EmailTemplateKeyNotFoundError,
  RequisitionContactDraftService,
} from '../communications/requisition-contact-draft.service.js';

// D-EMAIL-TPL-1 (ET-5) — template selection at the requisition-contact draft.
// At the pin the endpoint took no template_key; these assertions were unrunnable.
// Recipient/context are server-authoritative here (mocked as the real resolvers
// would return them); template_key only shapes wording.

const REQ = {
  requisition_number: 1000,
  title: 'Business Analyst',
  city: 'McLean',
  state: 'VA',
  work_arrangement: 'hybrid',
  job_type: 'contract',
  description: 'A day-shift analyst role.',
};

function makeService(source: ResolvedTemplateSource): RequisitionContactDraftService {
  const recipients = { resolveRecipientEmail: async () => 'talent@example.test' };
  const talents = { findById: async () => ({ first_name: 'Omvignesh', last_name: 'Murugesan' }) };
  const requisitions = { findByIdAdmin: async () => REQ };
  const pipelines = { findCurrentStageForTalentIds: async () => new Map([['t1', 'no_contact']]) };
  const identity = {
    findUserById: async () => ({ display_name: 'Alex Recruiter' }),
    findTenantNameById: async () => ({ name: 'Astre', display_name: 'Astre' }),
  };
  // The code-owned default resolver — DEFAULT-prefixed so we can distinguish it.
  const codeDefault = {
    resolveDefault: (ctx: { requisition_title: string; talent_first_name: string | null }) => ({
      subject: `DEFAULT ${ctx.requisition_title}`,
      body: `Hi ${ctx.talent_first_name ?? ''}`,
      template_id: 'system.requisition-contact.v1',
      template_version: '1',
      warnings: [] as string[],
    }),
  };
  const templateResolver = { resolveSource: async () => source };
  return new RequisitionContactDraftService(
    recipients as never,
    talents as never,
    requisitions as never,
    pipelines as never,
    identity as never,
    codeDefault as never,
    templateResolver as never,
  );
}

const baseArgs = { tenant_id: 'ten-1', recruiter_id: 'rec-1', talent_record_id: 't1', requisition_id: 'r1' };
const DEFAULT_SOURCE: ResolvedTemplateSource = { source: 'system_default', template_key: 'requisition-contact' };
const OVERRIDE_SOURCE: ResolvedTemplateSource = {
  source: 'tenant_override',
  template_id: 'row-1',
  template_key: 'requisition-contact',
  subject_template: 'Custom {{requisition.title}}',
  body_template: 'Yo {{talent.first_name}} at {{company.name}}',
};

describe('RequisitionContactDraftService (ET-5) — template selection', () => {
  it('template_key ABSENT → the code default, behaviour unchanged', async () => {
    const svc = makeService(OVERRIDE_SOURCE); // even if an override exists, absent must not use it
    const draft = await svc.prepareDraft(baseArgs);
    expect(draft.subject).toBe('DEFAULT Business Analyst');
    expect(draft.context.template_id).toBe('system.requisition-contact.v1');
    expect(draft.context.template_key).toBe('requisition-contact');
    expect(draft.to.editable).toBe(false); // recipient server-authoritative + locked
  });

  it('requisition-contact key + tenant override → override rendered from authoritative context', async () => {
    const svc = makeService(OVERRIDE_SOURCE);
    const draft = await svc.prepareDraft({ ...baseArgs, template_key: 'requisition-contact' });
    expect(draft.subject).toBe('Custom Business Analyst'); // {{requisition.title}} server-resolved
    expect(draft.body).toBe('Yo Omvignesh at Astre'); // {{talent.first_name}}, {{company.name}} server-resolved
    expect(draft.body).not.toMatch(/\{\{|\}\}/); // no raw token survives
    expect(draft.context.template_id).toBe('row-1'); // provenance = the override row id
    expect(draft.to.editable).toBe(false);
  });

  it('requisition-contact key + NO override → falls back to the code default', async () => {
    const svc = makeService(DEFAULT_SOURCE);
    const draft = await svc.prepareDraft({ ...baseArgs, template_key: 'requisition-contact' });
    expect(draft.subject).toBe('DEFAULT Business Analyst');
    expect(draft.context.template_id).toBe('system.requisition-contact.v1');
  });

  it('unknown template_key → fails closed (EmailTemplateKeyNotFoundError → 404 at the controller)', async () => {
    const svc = makeService(DEFAULT_SOURCE);
    await expect(svc.prepareDraft({ ...baseArgs, template_key: 'not-a-real-key' })).rejects.toBeInstanceOf(
      EmailTemplateKeyNotFoundError,
    );
  });
});
