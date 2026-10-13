import { describe, expect, it } from 'vitest';
import type { ConsentRepository } from '@aramo/consent';
import type { TalentRecordRepository } from '@aramo/talent-record';

import { AuthorizedTalentRetrievalReadAdapter } from '../talent-intelligence/authorized-talent-retrieval-read.adapter.js';

// TIP-E2E INC-2 — Correction A: contact-PII suppression is enforced in the adapter
// BEFORE data leaves it; non-contact attributes are preserved (governed by
// talent:read, not contactability); missing record → null.
const TENANT = '11111111-1111-7111-8111-111111111111';
const TALENT = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';

function view(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TALENT,
    tenant_id: TENANT,
    first_name: 'Ada',
    last_name: 'Lovelace',
    title: 'Engineer',
    city: 'Austin',
    state: 'TX',
    email1: 'ada@example.com',
    phone_cell: '+15125551234',
    work_authorization: 'US_CITIZEN',
    desired_pay: '$70/hr',
    current_pay: '$65/hr',
    engagement_type: 'w2',
    availability_status: 'available',
    date_available: '2026-11-01',
    key_skills: 'typescript',
    source: 'referral',
    owner_id: 'owner-1',
    created_at: '2026-10-01T00:00:00.000Z',
    recruiting_ready: true,
    record_status: 'live',
    superseded_by_record_id: null,
    ...over,
  };
}

function build(summaryValue: string | undefined, found = true) {
  const talent = {
    findById: async () => (found ? view() : null),
  } as unknown as TalentRecordRepository;
  const consent = {
    findContactingConsentSummaryForTalentIds: async () =>
      new Map<string, string>(summaryValue === undefined ? [] : [[TALENT, summaryValue]]),
  } as unknown as ConsentRepository;
  return new AuthorizedTalentRetrievalReadAdapter(talent, consent);
}

describe('AuthorizedTalentRetrievalReadAdapter (INC-2 Correction A)', () => {
  it('do_not_contact → contact channels suppressed (null); non-contact preserved', async () => {
    const r = await build('do_not_contact').getTalent({ tenant_id: TENANT, talent_id: TALENT });
    expect(r).not.toBeNull();
    expect(r!.email1).toBeNull();
    expect(r!.phone_cell).toBeNull();
    expect(r!.contactable).toBe(false);
    // Non-contact attributes remain (governed by talent:read, not contactability).
    expect(r!.first_name).toBe('Ada');
    expect(r!.title).toBe('Engineer');
    expect(r!.work_authorization).toBe('US_CITIZEN');
    expect(r!.desired_pay).toBe('$70/hr');
  });

  it('no consent grant (absent) → fail-closed suppression (do_not_contact default)', async () => {
    const r = await build(undefined).getTalent({ tenant_id: TENANT, talent_id: TALENT });
    expect(r!.email1).toBeNull();
    expect(r!.phone_cell).toBeNull();
    expect(r!.contactable).toBe(false);
  });

  it('contactable → contact channels returned; contactable true', async () => {
    const r = await build('contactable').getTalent({ tenant_id: TENANT, talent_id: TALENT });
    expect(r!.email1).toBe('ada@example.com');
    expect(r!.phone_cell).toBe('+15125551234');
    expect(r!.contactable).toBe(true);
  });

  it('missing record → null', async () => {
    const r = await build('contactable', false).getTalent({ tenant_id: TENANT, talent_id: TALENT });
    expect(r).toBeNull();
  });
});
