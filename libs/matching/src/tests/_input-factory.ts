import type { MatchingAnalysisInput } from '../lib/dto/matching-analysis-input.dto.js';
import { MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION } from '../lib/dto/version-pins.js';

// Baseline factory for engine + service tests. Returns an
// all-criteria-pass input for a Backend Engineer role with one critical
// skill that satisfies the ≥2 + ≥1 ingested threshold. Tests apply
// targeted overrides to flip individual fields and assert the
// resulting tier / failed_criteria.
//
// Default tier under no overrides: ENTRUSTABLE (every rule passes,
// every confidence indicator is high).
export function entrustablePass(
  overrides: Partial<MatchingAnalysisInput> = {},
): MatchingAnalysisInput {
  return {
    contract_version: MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION,

    id: '00000000-0000-7000-8000-000000000001',
    tenant_id: '11111111-1111-7111-8111-111111111111',
    talent_id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
    job_id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc',
    golden_profile_id: 'dddddddd-dddd-7ddd-8ddd-dddddddddddd',

    trigger: 'initial_match',
    rank_ordinal: 1,
    computed_at: new Date('2026-05-17T22:00:00Z'),

    role_family: 'backend_engineer',
    critical_skills: [
      { name: 'Java', evidence_count: 3, has_ingested_evidence: true },
    ],
    constraint_checks_evaluated: {
      location: 'pass',
      work_mode: 'pass',
      rate: 'pass',
      work_authorization: 'pass',
    },
    risk_flags_evaluated: [],
    confidence_indicators_evaluated: {
      evidence_strength: 'high',
      data_completeness: 'high',
      constraint_confidence: 'high',
    },
    blocking_conditions: {
      has_verified_contact_channel: true,
      consent_state_sufficient: true,
      has_conflicting_active_engagement: false,
    },

    why_matched_sentence: 'meets all critical skills with strong evidence',
    match_summary: 'Strong fit across required dimensions.',
    expanded_reasoning: [],
    skill_match: { matched: 1, missing: 0 },
    experience_match: { years: 7 },
    constraint_checks: {
      location: 'pass',
      work_mode: 'pass',
      rate: 'pass',
      work_authorization: 'pass',
    },
    strengths: ['java'],
    gaps: [],
    risk_flags: [],
    confidence_indicators: {
      evidence_strength: { level: 'high', basis: 'multi-source' },
      data_completeness: { level: 'high', basis: 'all fields present' },
      constraint_confidence: { level: 'high', basis: 'verified' },
    },
    freshness_indicator: { profile_age_days: 14 },

    ...overrides,
  };
}
