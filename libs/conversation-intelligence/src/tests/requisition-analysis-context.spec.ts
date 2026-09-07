import { describe, expect, it } from 'vitest';

import {
  buildRequisitionAnalysisContext,
  isRequisitionAnalysisContextV1,
  REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION,
  type RequisitionAnalysisSource,
} from '../lib/dto/requisition-analysis-context.js';

// CI-B2 unit — the snapshot builder is the allowlist authority. These
// proofs cover directive §10 field minimization (TEST 7), the schema
// version (TEST 6), and financial masking-by-construction (TEST 8).

function baseSource(
  overrides: Partial<RequisitionAnalysisSource> = {},
): RequisitionAnalysisSource {
  return {
    tenant_id: '11111111-1111-7111-8111-111111111111',
    requisition_id: '22222222-2222-7222-8222-222222222222',
    source_requisition_version: 3,
    golden_profile_id: null,
    title: 'Senior Platform Engineer',
    job_type: 'contract',
    labor_category: 'IT',
    role_family: 'software_engineering',
    seniority_level: 'senior',
    city: 'Austin',
    state: 'TX',
    postal_code: '78701',
    work_arrangement: 'hybrid',
    onsite_days_per_week: 3,
    travel_percent: 10,
    relocation_offered: false,
    duration_value: 12,
    duration_unit: 'months',
    hours_per_week: 40,
    extension_possible: true,
    work_authorization: 'us_citizen',
    golden_profile_content: null,
    ...overrides,
  };
}

describe('buildRequisitionAnalysisContext', () => {
  it('TEST 6 — self-tags the deterministic non-null schema version', () => {
    const ctx = buildRequisitionAnalysisContext(baseSource());
    expect(ctx.schema_version).toBe(REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION);
    expect(ctx.schema_version).toBe('ci.requisition-analysis-context.v1');
  });

  it('TEST 7 — captures exactly the allowlisted recruiting categories', () => {
    const ctx = buildRequisitionAnalysisContext(baseSource());
    expect(Object.keys(ctx).sort()).toEqual(
      [
        'engagement',
        'golden_profile',
        'location',
        'role',
        'schema_version',
        'work_arrangement',
        'work_authorization',
      ].sort(),
    );
    expect(ctx.role).toEqual({
      title: 'Senior Platform Engineer',
      job_type: 'contract',
      labor_category: 'IT',
      role_family: 'software_engineering',
      seniority_level: 'senior',
    });
    expect(ctx.location).toEqual({
      city: 'Austin',
      state: 'TX',
      postal_code: '78701',
    });
    expect(ctx.work_authorization).toBe('us_citizen');
  });

  it('TEST 8 — no compensation / financial-planning value can enter the payload', () => {
    // A caller cannot smuggle gated fields in: even if extra keys are
    // present on the source object, the builder copies only the allowlist.
    const contaminated = {
      ...baseSource(),
      // These are NOT on RequisitionAnalysisSource; simulate a rogue caller.
      pay_rate_amount: '145.00',
      bill_rate_amount: '210.00',
      salary_amount: '190000.00',
      target_margin_percent: '31.00',
      min_bill_rate: '180.00',
      max_pay_rate: '160.00',
    } as unknown as RequisitionAnalysisSource;
    const ctx = buildRequisitionAnalysisContext(contaminated);
    const serialized = JSON.stringify(ctx);
    for (const banned of [
      'pay_rate',
      'bill_rate',
      'placement_fee',
      'salary',
      'target_margin_percent',
      'markup_percent_target',
      'rate_card_id',
      'min_bill_rate',
      'max_bill_rate',
      'min_pay_rate',
      'max_pay_rate',
      '145.00',
      '210.00',
      '190000.00',
      '31.00',
    ]) {
      expect(serialized).not.toContain(banned);
    }
  });

  it('captures GoldenProfile content when present + omits it when unminted', () => {
    const withProfile = buildRequisitionAnalysisContext(
      baseSource({
        golden_profile_id: '33333333-3333-7333-8333-333333333333',
        golden_profile_content: {
          role_family: 'software_engineering',
          seniority_level: 'senior',
          jd_text: 'Build the platform.',
          generated_by: 'manual',
          required_skills: [{ name: 'TypeScript', min_years: 5 }],
          preferred_skills: [{ name: 'Rust' }],
          critical_skills: [{ name: 'TypeScript' }],
          experience: { total_years: 8, industries: ['staffing'] },
          constraints: { work_authorization: 'us_citizen' },
        },
      }),
    );
    expect(withProfile.golden_profile?.golden_profile_id).toBe(
      '33333333-3333-7333-8333-333333333333',
    );
    expect(withProfile.golden_profile?.content.required_skills).toEqual([
      { name: 'TypeScript', min_years: 5 },
    ]);

    // golden_profile_id present but content unresolved (e.g. cross-tenant
    // conceal) → golden_profile is null, never a dangling pointer.
    const danglingPointer = buildRequisitionAnalysisContext(
      baseSource({
        golden_profile_id: '33333333-3333-7333-8333-333333333333',
        golden_profile_content: null,
      }),
    );
    expect(danglingPointer.golden_profile).toBeNull();
  });
});

describe('isRequisitionAnalysisContextV1', () => {
  it('accepts a built payload and rejects wrong-version / malformed blobs', () => {
    expect(isRequisitionAnalysisContextV1(buildRequisitionAnalysisContext(baseSource()))).toBe(true);
    expect(isRequisitionAnalysisContextV1(null)).toBe(false);
    expect(isRequisitionAnalysisContextV1({ schema_version: 'ci.requisition-analysis-context.v0' })).toBe(false);
    expect(isRequisitionAnalysisContextV1({ schema_version: REQUISITION_ANALYSIS_CONTEXT_SCHEMA_VERSION })).toBe(false);
  });
});
