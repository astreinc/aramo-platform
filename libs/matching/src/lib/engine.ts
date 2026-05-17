import type { ExaminationTierValue } from '@aramo/examination';

import type {
  MatchingAnalysisInput,
  RoleFamily,
} from './dto/matching-analysis-input.dto.js';
import { MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION } from './dto/version-pins.js';

// M3 PR-2 §3.2 — the deterministic entrustability engine.
//
// Pure function: MatchingAnalysisInput → { tier, failed_criteria[] }.
// No I/O, no async, no recruiter input, no clock-dependence (the input
// supplies computed_at; the engine never reads the clock).
//
// Implements the §2.5 Entrustability Rule Set exactly:
//   - Skill Evidence Rule (per-critical-skill: evidence_count ≥ role-
//     family threshold + ≥1 ingested unless PM/BA)
//   - Constraint Rule (all four constraint_checks === 'pass')
//   - Risk Rule (no risk_flag with severity === 'high')
//   - Confidence Rule (each of 3 confidence_indicators ≥ 'medium')
//   - Blocking Conditions Rule (8 specific conditions; most overlap with
//     other rule groups since §2.5 lists them as the same hard failures)
//
// Tier classification per §2.5:
//   - ENTRUSTABLE: passes ALL Entrustability Criteria (no failures)
//   - WORTH_CONSIDERING: passes ALL hard criteria, fails ≥1 soft
//   - STRETCH: fails ≥1 hard criteria
//
// Hard vs soft categorization per §2.5 ("Hard criteria = failure of
// Entrustability Rule Set; reference-based; no parallel list"):
//   - The 4 SOFT failures (explicitly enumerated by §2.5):
//       * insufficient evidence_count (but ≥1 exists)
//       * evidence_strength = 'low'
//       * data_completeness = 'low'
//       * constraint_confidence = 'low'
//   - Everything else that fails the Rule Set is HARD.
//
// PR-2 does NOT implement recruiter overrides, submittal permission,
// justification, attestation, or any §2.5 Audit Specification surface
// (those are later PRs).

// Role-Family evidence-count thresholds from §2.5 Threshold Calibration.
// Architect = 3; everyone else = 2. PM/BA do not require ingested.
export const EVIDENCE_THRESHOLDS: Readonly<
  Record<RoleFamily, { readonly count: number; readonly requires_ingested: boolean }>
> = {
  backend_engineer:        { count: 2, requires_ingested: true },
  frontend_engineer:       { count: 2, requires_ingested: true },
  fullstack_engineer:      { count: 2, requires_ingested: true },
  devops_sre:              { count: 2, requires_ingested: true },
  data_engineer:           { count: 2, requires_ingested: true },
  architect:               { count: 3, requires_ingested: true },
  qa_test_engineer:        { count: 2, requires_ingested: true },
  product_project_manager: { count: 2, requires_ingested: false },
  business_analyst:        { count: 2, requires_ingested: false },
};

// §2.5 Audit Specification: failed_criteria[] shape (Diagnostic).
//   { criterion, field_path, observed_value, expected_threshold }
export interface FailedCriterion {
  criterion: string;
  field_path: string;
  observed_value: string;
  expected_threshold: string;
}

export interface EntrustabilityExamination {
  tier: ExaminationTierValue;
  failed_criteria: readonly FailedCriterion[];
  // Categorization is preserved on the result so the persistence layer
  // (matching.service.ts) can construct delta_to_entrustable per §2.4
  // (blockers populated from failed criteria — §2.5 "when entrustability
  // fails, failed criteria populate delta_to_entrustable.blockers").
  hard_failures: readonly FailedCriterion[];
  soft_failures: readonly FailedCriterion[];
}

function formatExpectedThreshold(
  threshold: { count: number; requires_ingested: boolean },
): string {
  return threshold.requires_ingested
    ? `>= ${String(threshold.count)} with >=1 ingested`
    : `>= ${String(threshold.count)}`;
}

export function evaluateEntrustability(
  input: MatchingAnalysisInput,
): EntrustabilityExamination {
  // Contract-version compatibility check (§3.1 / §3.4 coupling). A
  // mismatch indicates the analysis layer is emitting a contract shape
  // the engine wasn't built against; refuse rather than silently
  // produce a snapshot from an unknown shape.
  if (input.contract_version !== MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION) {
    throw new Error(
      `MatchingAnalysisInput contract_version mismatch: engine expects ${MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION}, received ${String(input.contract_version)}`,
    );
  }

  const hard: FailedCriterion[] = [];
  const soft: FailedCriterion[] = [];
  const threshold = EVIDENCE_THRESHOLDS[input.role_family];
  const expected = formatExpectedThreshold(threshold);

  // -- Skill Evidence Rule + Blocking Conditions ("missing ANY critical skill") --
  for (const skill of input.critical_skills) {
    if (skill.evidence_count === 0) {
      // Blocking Condition: missing critical skill (0 evidence) — HARD.
      hard.push({
        criterion: `missing_critical_skill (${skill.name})`,
        field_path: `skill_match.matched_critical_skills[${skill.name}].evidence_count`,
        observed_value: '0',
        expected_threshold: expected,
      });
      continue;
    }
    if (skill.evidence_count < threshold.count) {
      // §2.5 Soft: insufficient evidence_count (but ≥1 exists).
      soft.push({
        criterion: `skill_evidence_count (${skill.name})`,
        field_path: `skill_match.matched_critical_skills[${skill.name}].evidence_count`,
        observed_value: String(skill.evidence_count),
        expected_threshold: expected,
      });
    }
    // Ingested-source requirement (engineering roles): part of the
    // Skill Evidence Rule, not in §2.5's soft list — HARD.
    if (threshold.requires_ingested && !skill.has_ingested_evidence) {
      hard.push({
        criterion: `skill_ingested_evidence (${skill.name})`,
        field_path: `skill_match.matched_critical_skills[${skill.name}].has_ingested_evidence`,
        observed_value: 'false',
        expected_threshold: '>= 1 ingested',
      });
    }
  }

  // -- Constraint Rule + Blocking Conditions ("X = fail" for the four) --
  // Any non-'pass' status fails the Constraint Rule; §2.5's soft list
  // does not include constraint statuses, so every non-pass is HARD.
  const constraintFields: readonly (keyof typeof input.constraint_checks_evaluated)[] = [
    'location',
    'work_mode',
    'rate',
    'work_authorization',
  ];
  for (const field of constraintFields) {
    const value = input.constraint_checks_evaluated[field];
    if (value !== 'pass') {
      hard.push({
        criterion: `constraint_${field}`,
        field_path: `constraint_checks.${field}`,
        observed_value: value,
        expected_threshold: 'pass',
      });
    }
  }

  // -- Risk Rule: no risk_flag with severity = 'high' --
  for (let i = 0; i < input.risk_flags_evaluated.length; i++) {
    const flag = input.risk_flags_evaluated[i];
    if (flag !== undefined && flag.severity === 'high') {
      hard.push({
        criterion: 'risk_flag_high_severity',
        field_path: `risk_flags[${String(i)}].severity`,
        observed_value: 'high',
        expected_threshold: 'no severity=high',
      });
    }
  }

  // -- Confidence Rule: each indicator must be ≥ 'medium' --
  // The three §2.5 soft criteria mapped directly: each = 'low' is SOFT.
  // The level domain is {low, medium, high}, so "below medium" === 'low'.
  const confidenceFields: readonly (keyof typeof input.confidence_indicators_evaluated)[] = [
    'evidence_strength',
    'data_completeness',
    'constraint_confidence',
  ];
  for (const field of confidenceFields) {
    if (input.confidence_indicators_evaluated[field] === 'low') {
      soft.push({
        criterion: field,
        field_path: `confidence_indicators.${field}`,
        observed_value: 'low',
        expected_threshold: '>= medium',
      });
    }
  }

  // -- Blocking Conditions Rule: the three not covered above --
  if (!input.blocking_conditions.has_verified_contact_channel) {
    hard.push({
      criterion: 'no_verified_contact_channel',
      field_path: 'blocking_conditions.has_verified_contact_channel',
      observed_value: 'false',
      expected_threshold: 'true',
    });
  }
  if (!input.blocking_conditions.consent_state_sufficient) {
    hard.push({
      criterion: 'consent_state_insufficient',
      field_path: 'blocking_conditions.consent_state_sufficient',
      observed_value: 'false',
      expected_threshold: 'true',
    });
  }
  if (input.blocking_conditions.has_conflicting_active_engagement) {
    hard.push({
      criterion: 'conflicting_active_engagement',
      field_path: 'blocking_conditions.has_conflicting_active_engagement',
      observed_value: 'true',
      expected_threshold: 'false',
    });
  }

  // -- Tier classification (§2.5) --
  let tier: ExaminationTierValue;
  if (hard.length > 0) {
    tier = 'STRETCH';
  } else if (soft.length > 0) {
    tier = 'WORTH_CONSIDERING';
  } else {
    tier = 'ENTRUSTABLE';
  }

  return {
    tier,
    failed_criteria: [...hard, ...soft],
    hard_failures: hard,
    soft_failures: soft,
  };
}
