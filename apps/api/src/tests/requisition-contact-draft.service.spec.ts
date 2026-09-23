import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RequisitionContactDraftService } from '../communications/requisition-contact-draft.service.js';
import { RequisitionContactContextError } from '../communications/requisition-contact-context.error.js';
import { SystemRequisitionContactTemplateService } from '../communications/system-requisition-contact-template.service.js';
import { TalentEmailUnavailableError } from '../microsoft/email-recipient-resolver.port.js';

// COMM-C4 (RCE-1) — draft-orchestration proofs. The draft endpoint WRITES
// NOTHING, so this is exercised with faked authoritative reads (no DB): valid
// context hydrates; recipient comes from the SAME resolver introduced in C;
// to.editable is false; an unassociated / cross-tenant Talent or requisition,
// and a missing recipient, all fail closed; the service performs zero Graph /
// interaction / pipeline side-effects (its fakes expose reads only).

const TENANT = randomUUID();
const RECRUITER = randomUUID();
const TALENT = randomUUID();
const REQ = randomUUID();
const AUTH_EMAIL = 'authoritative@talent.example';

class FakeRecipients {
  email: string | null = AUTH_EMAIL;
  calls = 0;
  async resolveRecipientEmail(req: { tenant_id: string; talent_record_id: string }): Promise<string> {
    this.calls += 1;
    if (this.email === null) throw new TalentEmailUnavailableError(req.talent_record_id);
    return this.email;
  }
}

// READ-ONLY fakes — no write/mutation method exists, so any attempted side
// effect would throw (proves the draft path never mutates).
class FakeTalents {
  async findById() {
    return { first_name: 'Omvignesh', last_name: 'Murugesan' };
  }
}
class FakeRequisitions {
  exists = true;
  async findByIdAdmin() {
    return this.exists
      ? {
          title: 'Business Analyst - Multi-Family',
          requisition_number: 1000,
          city: 'McLean',
          state: 'VA',
          work_arrangement: 'hybrid',
          job_type: 'contract',
          description: 'Work with product owners in the multi-family domain.',
        }
      : null;
  }
}
class FakePipelines {
  associated = true;
  reads = 0;
  async findCurrentStageForTalentIds(args: { talent_record_ids: readonly string[] }) {
    this.reads += 1;
    const m = new Map<string, { requisition_id: string; status: string }>();
    if (this.associated) m.set(args.talent_record_ids[0]!, { requisition_id: REQ, status: 'contacted' });
    return m;
  }
}
class FakeIdentity {
  async findUserById() {
    return { display_name: 'Purush Pichaimuthu' };
  }
  async findTenantNameById() {
    return { name: 'Astre', display_name: 'Astre Consulting Services Inc' };
  }
}

function make(over: {
  recipients?: FakeRecipients;
  requisitions?: FakeRequisitions;
  pipelines?: FakePipelines;
} = {}) {
  const recipients = over.recipients ?? new FakeRecipients();
  const requisitions = over.requisitions ?? new FakeRequisitions();
  const pipelines = over.pipelines ?? new FakePipelines();
  const svc = new RequisitionContactDraftService(
    recipients,
    new FakeTalents() as never,
    requisitions as never,
    pipelines as never,
    new FakeIdentity() as never,
    new SystemRequisitionContactTemplateService(),
  );
  return { svc, recipients, requisitions, pipelines };
}

const args = { tenant_id: TENANT, recruiter_id: RECRUITER, talent_record_id: TALENT, requisition_id: REQ };

describe('RequisitionContactDraftService (COMM-C4 draft orchestration)', () => {
  it('valid Talent/Requisition returns a hydrated draft with server-owned recipient', async () => {
    const { svc, recipients, pipelines } = make();
    const view = await svc.prepareDraft(args);
    // recipient comes from the SAME authoritative resolver introduced in C.
    expect(view.to.email).toBe(AUTH_EMAIL);
    expect(recipients.calls).toBe(1);
    // recipient is server-owned / display-only.
    expect(view.to.editable).toBe(false);
    expect(view.to.display_name).toBe('Omvignesh Murugesan');
    // subject/body carry resolved requisition + talent context; no placeholders.
    expect(view.subject).toBe('Business Analyst - Multi-Family — McLean, VA (Contract)');
    expect(view.body).toContain('Hi Omvignesh,');
    expect(view.body).toContain('opportunity (REQ-1000)');
    expect(view.body).not.toMatch(/[{}]/);
    expect(view.context).toEqual({
      requisition_reference: 'REQ-1000',
      requisition_title: 'Business Analyst - Multi-Family',
      template_id: 'system.requisition-contact.v1',
      template_version: '1',
    });
    expect(view.warnings).toBeUndefined();
    // association was checked by a READ (no mutation surface exists on the fake).
    expect(pipelines.reads).toBe(1);
  });

  it('a cross-tenant / absent requisition fails closed (requisition_not_found)', async () => {
    const requisitions = new FakeRequisitions();
    requisitions.exists = false;
    const { svc } = make({ requisitions });
    await expect(svc.prepareDraft(args)).rejects.toMatchObject({
      name: 'RequisitionContactContextError',
      reason: 'requisition_not_found',
    });
  });

  it('a Talent not associated with the requisition (incl. cross-tenant Talent) fails closed', async () => {
    const pipelines = new FakePipelines();
    pipelines.associated = false;
    const { svc, recipients } = make({ pipelines });
    await expect(svc.prepareDraft(args)).rejects.toBeInstanceOf(RequisitionContactContextError);
    await expect(svc.prepareDraft(args)).rejects.toMatchObject({
      reason: 'talent_not_associated_with_requisition',
    });
    // recipient resolution never runs when the association is invalid.
    expect(recipients.calls).toBe(0);
  });

  it('a missing authoritative recipient fails closed with the C recipient-unavailable error', async () => {
    const recipients = new FakeRecipients();
    recipients.email = null;
    const { svc } = make({ recipients });
    await expect(svc.prepareDraft(args)).rejects.toBeInstanceOf(TalentEmailUnavailableError);
  });
});
