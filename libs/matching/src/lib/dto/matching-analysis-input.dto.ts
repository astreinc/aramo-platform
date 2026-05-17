import type { ExaminationTriggerValue } from '@aramo/examination';

// MatchingAnalysisInput — M3 PR-2 §3.1 contract.
//
// The deterministic entrustability engine operates on this explicit,
// versioned input type. The contract is the documented seam between
// PR-2's engine and the later matching-analysis PR that populates it
// from real data. PR-2 does NOT populate it from real data — it
// consumes it.
//
// Two field groups per directive §3.1:
//
//   (a) §2.5-evaluated fields — the structured inputs the engine's
//       rule set reads: per-critical-skill evidence_count +
//       ingested-source indicator, the four constraint_checks with
//       pass/partial/fail/unknown status, risk_flags with severities,
//       the three confidence_indicators, the job's role family
//       (selecting the §2.5 calibration threshold), and the additional
//       blocking-condition booleans §2.5 enumerates.
//
//   (b) §2.4 analysis-product fields — the nine Json fields PR-1's
//       CreateExaminationSnapshotInput makes required + the three
//       scalars (why_matched_sentence, match_summary, rank_ordinal).
//       The engine forwards these unchanged into createSnapshot; the
//       repository persists them opaquely per §3.3.
//
// The contract carries a `contract_version` identifier per §3.1; the
// engine asserts compatibility at evaluate-time so the analysis layer
// and engine evolve against a known shape.

import { MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION } from './version-pins.js';

// ----------------- (a) §2.5-evaluated typed sub-shapes -----------------

// Role-Family Calibration table from §2.5 — 9 closed values.
// Engineering roles require ≥1 ingested corroboration; PM/BA roles do
// not (§2.5 Threshold Calibration "Engineering roles require at least
// one ingested corroboration. PM/BA roles allow declared + conversational
// validation due to weaker ingestion signals.").
export const ROLE_FAMILIES = [
  'backend_engineer',
  'frontend_engineer',
  'fullstack_engineer',
  'devops_sre',
  'data_engineer',
  'architect',
  'qa_test_engineer',
  'product_project_manager',
  'business_analyst',
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

// §2.5 constraint_checks status — pass/partial/fail/unknown. The rule
// requires pass; anything else is a failure (and most non-pass values
// also map to blocking conditions, all of which are hard).
export const CONSTRAINT_CHECK_STATUSES = ['pass', 'partial', 'fail', 'unknown'] as const;
export type ConstraintCheckStatus = (typeof CONSTRAINT_CHECK_STATUSES)[number];

// §2.5 confidence_indicators level — low/medium/high.
// Rule: each must be >= medium. "low" maps to the soft criteria list.
export const CONFIDENCE_LEVELS = ['low', 'medium', 'high'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

// §2.4 RiskFlag severity — low/medium/high.
// Rule: no risk_flag with severity = "high" may exist.
export const RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

// One critical skill on the job's Golden Profile. evidence_count is the
// matched count for this skill; has_ingested_evidence indicates whether
// at least one matched evidence was from an ingested source.
//
// The skill name (the Map key in §2.5's example field_path) is opaque
// to the engine; it just appears in failed_criteria emission.
export interface CriticalSkillExamination {
  name: string;
  evidence_count: number;
  has_ingested_evidence: boolean;
}

// The four constraint_checks the rule examines, each with one of the
// four §2.5 status values.
export interface ConstraintChecksEvaluated {
  location: ConstraintCheckStatus;
  work_mode: ConstraintCheckStatus;
  rate: ConstraintCheckStatus;
  work_authorization: ConstraintCheckStatus;
}

// The three §2.5 confidence_indicators.
export interface ConfidenceIndicatorsEvaluated {
  evidence_strength: ConfidenceLevel;
  data_completeness: ConfidenceLevel;
  constraint_confidence: ConfidenceLevel;
}

// One risk flag as seen by the engine — the engine only reads severity.
export interface RiskFlagEvaluated {
  severity: RiskSeverity;
}

// Additional §2.5 Blocking Conditions Rule inputs not already covered
// by the per-skill / constraint_checks groups above. The other blocking
// conditions are derived from those structured inputs:
//   - "work_authorization = fail" → constraint_checks_evaluated.work_authorization === 'fail'
//   - "missing ANY critical skill (0 evidence)" → critical_skills[].evidence_count === 0
//   - "rate outside acceptable range (fail)" → constraint_checks_evaluated.rate === 'fail'
//   - "location incompatibility (fail)" → constraint_checks_evaluated.location === 'fail'
//   - "work_mode incompatibility (fail)" → constraint_checks_evaluated.work_mode === 'fail'
// The remaining three need their own booleans.
export interface BlockingConditions {
  has_verified_contact_channel: boolean;
  consent_state_sufficient: boolean;
  has_conflicting_active_engagement: boolean;
}

// ----------------- The contract -----------------

export interface MatchingAnalysisInput {
  // Contract version identifier. The engine asserts compatibility with
  // MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION (§3.1 / §3.4 coupling).
  contract_version: typeof MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION;

  // ---- identity (forwarded to the snapshot) ----
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  golden_profile_id: string;

  // ---- engine-pinned fields (forwarded to the snapshot) ----
  trigger: ExaminationTriggerValue;
  rank_ordinal: number;
  computed_at: Date;

  // ---- (a) §2.5-evaluated structured fields ----
  role_family: RoleFamily;
  critical_skills: readonly CriticalSkillExamination[];
  constraint_checks_evaluated: ConstraintChecksEvaluated;
  risk_flags_evaluated: readonly RiskFlagEvaluated[];
  confidence_indicators_evaluated: ConfidenceIndicatorsEvaluated;
  blocking_conditions: BlockingConditions;

  // ---- (b) §2.4 analysis-product fields forwarded to the snapshot ----
  // The nine required Json fields (PR-1 §3.1 made them non-nullable on
  // CreateExaminationSnapshotInput). The engine passes these through
  // opaquely; their internal shapes are §2.4 concerns the analysis-
  // layer PR will construct.
  why_matched_sentence: string;
  match_summary: string;
  expanded_reasoning: unknown;
  skill_match: unknown;
  experience_match: unknown;
  constraint_checks: unknown;
  strengths: unknown;
  gaps: unknown;
  risk_flags: unknown;
  confidence_indicators: unknown;
  freshness_indicator: unknown;
}
