import { describe, expect, it } from 'vitest';

import type { RequisitionView } from '../lib/dto/requisition.view.js';
import {
  buildProfilePrompt,
  extractRoleContent,
  parseProfileCompletion,
} from '../lib/profile-prompt.js';

// Job-Module LB-3 — THE G4 PROOF (ADR-0015 v1.2, the binding §4 gate 3).
//
// G4: commercial/financial data + internal notes are NEVER sent to the
// LLM. The generation prompt is built from the role-content ALLOWLIST, so
// a Requisition carrying pay/bill/margin/markup/fee/salary/rate-card/
// min-max-rate/notes values does NOT leak them into the prompt. The
// sentinel values below would be unmistakable in the prompt if they
// leaked.

const COMMERCIAL_SENTINELS = [
  'PAYSENTINEL_8888',
  'BILLSENTINEL_9999',
  'MARGINSENTINEL_7777',
  'MARKUPSENTINEL_6666',
  'FEESENTINEL_5555',
  'SALARYSENTINEL_4444',
  'RATECARDSENTINEL_3333',
  'NOTESSENTINEL_2222',
] as const;

function viewWithCommercialData(): RequisitionView {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: '00000000-0000-7000-8000-0000000000aa',
    site_id: null,
    title: 'Senior Backend Engineer',
    company_id: '00000000-0000-7000-8000-0000000000bb',
    contact_id: null,
    company_department_id: null,
    status: 'active',
    type: null,
    duration: null,
    description: null,
    notes: 'NOTESSENTINEL_2222 internal-only do-not-share',
    is_hot: false,
    openings: 1,
    openings_available: 1,
    start_date: null,
    city: 'Austin',
    state: 'TX',
    recruiter_id: null,
    owner_id: null,
    entered_by_id: null,
    created_at: '2026-06-11T00:00:00.000Z',
    updated_at: '2026-06-11T00:00:00.000Z',
    // Compensation actuals (gated) — MUST NOT reach the prompt.
    compensation_model: 'CONTRACT',
    pay_rate_amount: 'PAYSENTINEL_8888',
    pay_rate_currency: 'USD',
    pay_rate_period: 'HOURLY',
    bill_rate_amount: 'BILLSENTINEL_9999',
    bill_rate_currency: 'USD',
    bill_rate_period: 'HOURLY',
    placement_fee_percent: 'FEESENTINEL_5555',
    placement_fee_amount: null,
    salary_amount: 'SALARYSENTINEL_4444',
    salary_currency: 'USD',
    margin_amount: 'MARGINSENTINEL_7777',
    markup_percent: 'MARKUPSENTINEL_6666',
    margin_percent: null,
    // Enterprise role-content (allowlisted — these MAY appear).
    job_type: 'contract',
    labor_category: 'IT',
    role_family: 'backend_engineer',
    seniority_level: 'senior',
    headcount_reason: 'new',
    work_arrangement: 'remote',
    travel_percent: 10,
    relocation_offered: false,
    work_authorization: 'us_citizen',
    end_date: null,
    duration_value: 6,
    duration_unit: 'months',
    extension_possible: true,
    hours_per_week: 40,
    source_system: 'manual',
    external_req_id: null,
    imported_at: null,
    // Financial-planning (gated) — MUST NOT reach the prompt.
    target_margin_percent: 'MARGINSENTINEL_7777',
    markup_percent_target: 'MARKUPSENTINEL_6666',
    rate_card_id: 'RATECARDSENTINEL_3333',
    min_bill_rate: 'BILLSENTINEL_9999',
    max_bill_rate: 'BILLSENTINEL_9999',
    min_pay_rate: 'PAYSENTINEL_8888',
    max_pay_rate: 'PAYSENTINEL_8888',
    golden_profile_id: null,
  };
}

describe('Job-Module G4 — commercial/notes are NEVER sent to the LLM', () => {
  it('extractRoleContent drops every commercial/financial/notes field', () => {
    const role = extractRoleContent(viewWithCommercialData());
    const serialized = JSON.stringify(role);
    for (const sentinel of COMMERCIAL_SENTINELS) {
      expect(serialized, `leaked ${sentinel} into role content`).not.toContain(sentinel);
    }
  });

  it('the built prompt contains NONE of the commercial/notes sentinels', () => {
    const role = extractRoleContent(viewWithCommercialData());
    const { prompt, system_message } = buildProfilePrompt({
      brief: 'Need a strong backend engineer for a fintech client.',
      role,
    });
    for (const sentinel of COMMERCIAL_SENTINELS) {
      expect(prompt, `leaked ${sentinel} into prompt`).not.toContain(sentinel);
      expect(system_message).not.toContain(sentinel);
    }
  });

  it('the prompt DOES carry allowlisted role content (positive control)', () => {
    const role = extractRoleContent(viewWithCommercialData());
    const { prompt } = buildProfilePrompt({ brief: 'brief', role });
    expect(prompt).toContain('Senior Backend Engineer');
    expect(prompt).toContain('backend_engineer');
    expect(prompt).toContain('remote');
  });

  it('parseProfileCompletion tolerates non-JSON (falls back to JD prose)', () => {
    const out = parseProfileCompletion('Just some prose, no JSON here.', 'brief');
    expect(out.jd_text).toContain('Just some prose');
    expect(out.golden_profile.generated_by).toBe('ai_draft');
    expect(out.golden_profile.critical_skills).toEqual([]);
  });

  it('parseProfileCompletion extracts a JSON envelope', () => {
    const completion =
      'Here you go: {"jd_text":"A great role","golden_profile":{"role_family":"backend_engineer","critical_skills":[{"name":"Go","min_years":3}],"constraints":{"work_mode":"remote"}}}';
    const out = parseProfileCompletion(completion, 'brief');
    expect(out.jd_text).toBe('A great role');
    expect(out.golden_profile.critical_skills).toEqual([{ name: 'Go', min_years: 3 }]);
    expect(out.golden_profile.constraints.work_mode).toBe('remote');
  });
});
