import type { ConsentRepository, ConsentSummary } from '@aramo/consent';
import type { PipelineView } from '@aramo/pipeline';
import type {
  TalentContactFields,
  TalentRecordRepository,
} from '@aramo/talent-record';
import { describe, expect, it, vi } from 'vitest';

import { PipelineTalentEnrichmentService } from '../pipeline-enrichment/pipeline-talent-enrichment.service.js';

// R-LAYERING proof (Aramo-Requisition-Expander-Talent-Rate-Columns v1.0):
// AUTHZ (talent:read) gates EXISTENCE; CONSENT (do_not_contact) gates only the
// CONTACT CHANNELS (email/phone) — never location/work_auth/desired_rate. These
// tests prove the SUPPRESSION behaviour, not just the happy path.

const CONTACT: TalentContactFields = {
  email: 'sarah@example.com',
  phone: '(571) 555-0100',
  city: 'Reston',
  state: 'VA',
  work_authorization: 'US Citizen',
  desired_pay: '$90/hr',
};

function makeSvc(
  contacts: Array<[string, TalentContactFields]>,
  consent: Array<[string, ConsentSummary]>,
) {
  const talent = {
    findContactByIds: vi.fn(async () => new Map(contacts)),
  } as unknown as TalentRecordRepository;
  const consentRepo = {
    findContactingConsentSummaryForTalentIds: vi.fn(async () => new Map(consent)),
  } as unknown as ConsentRepository;
  return {
    svc: new PipelineTalentEnrichmentService(talent, consentRepo),
    talent,
    consentRepo,
  };
}

function row(id: string, talent_id: string): PipelineView {
  return {
    id,
    tenant_id: 'T',
    site_id: null,
    talent_record_id: talent_id,
    requisition_id: 'R',
    status: 'submitted',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

describe('PipelineTalentEnrichmentService — R-LAYERING', () => {
  it('positive: talent:read + contactable → all five fields populated', async () => {
    const { svc } = makeSvc([['t1', CONTACT]], [['t1', 'contactable']]);
    const [out] = await svc.enrich([row('p1', 't1')], {
      tenant_id: 'T',
      canReadTalent: true,
    });
    expect(out).toMatchObject({
      email: 'sarah@example.com',
      phone: '(571) 555-0100',
      location: 'Reston, VA',
      work_auth: 'US Citizen',
      desired_rate: '$90/hr',
    });
  });

  it('AUTHZ gate: no talent:read → all five null AND no PII read is issued', async () => {
    const { svc, talent, consentRepo } = makeSvc(
      [['t1', CONTACT]],
      [['t1', 'contactable']],
    );
    const [out] = await svc.enrich([row('p1', 't1')], {
      tenant_id: 'T',
      canReadTalent: false,
    });
    expect(out).toMatchObject({
      email: null,
      phone: null,
      location: null,
      work_auth: null,
      desired_rate: null,
    });
    // Defence in depth: no read issued at all when the field may not exist.
    expect(talent.findContactByIds).not.toHaveBeenCalled();
    expect(
      consentRepo.findContactingConsentSummaryForTalentIds,
    ).not.toHaveBeenCalled();
  });

  it('CONSENT gate: do_not_contact suppresses ONLY email+phone; keeps location/work_auth/desired_rate', async () => {
    const { svc } = makeSvc([['t1', CONTACT]], [['t1', 'do_not_contact']]);
    const [out] = await svc.enrich([row('p1', 't1')], {
      tenant_id: 'T',
      canReadTalent: true,
    });
    expect(out.email).toBeNull();
    expect(out.phone).toBeNull();
    // The non-contact attributes MUST survive do_not_contact.
    expect(out).toMatchObject({
      location: 'Reston, VA',
      work_auth: 'US Citizen',
      desired_rate: '$90/hr',
    });
  });

  it('default-deny: no consent signal is treated as do_not_contact (email/phone suppressed)', async () => {
    const { svc } = makeSvc([['t1', CONTACT]], []); // no consent row
    const [out] = await svc.enrich([row('p1', 't1')], {
      tenant_id: 'T',
      canReadTalent: true,
    });
    expect(out.email).toBeNull();
    expect(out.phone).toBeNull();
    expect(out.desired_rate).toBe('$90/hr');
  });

  it('missing live record (superseded/cross-tenant) → all five null', async () => {
    const { svc } = makeSvc([], [['t1', 'contactable']]);
    const [out] = await svc.enrich([row('p1', 't1')], {
      tenant_id: 'T',
      canReadTalent: true,
    });
    expect(out).toMatchObject({
      email: null,
      phone: null,
      location: null,
      work_auth: null,
      desired_rate: null,
    });
  });

  it('tenant isolation: passes the request tenant_id to both batch reads', async () => {
    const { svc, talent, consentRepo } = makeSvc(
      [['t1', CONTACT]],
      [['t1', 'contactable']],
    );
    await svc.enrich([row('p1', 't1')], {
      tenant_id: 'TENANT-X',
      canReadTalent: true,
    });
    expect(talent.findContactByIds).toHaveBeenCalledWith('TENANT-X', ['t1']);
    expect(
      consentRepo.findContactingConsentSummaryForTalentIds,
    ).toHaveBeenCalledWith({ tenant_id: 'TENANT-X', talent_record_ids: ['t1'] });
  });

  it('empty page → no reads, returns []', async () => {
    const { svc, talent } = makeSvc([], []);
    const out = await svc.enrich([], { tenant_id: 'T', canReadTalent: true });
    expect(out).toEqual([]);
    expect(talent.findContactByIds).not.toHaveBeenCalled();
  });
});
