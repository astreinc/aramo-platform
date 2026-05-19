// Typed projection shapes for the M3 PR-6 read-side projection over
// PR-1's TalentJobExamination row. Two categories per the PR-6 directive:
//
//   1) FULLY-SPECIFIED types — built to Group 2 §2.4 type literal EXACTLY.
//      Every field, every enum value, optionality traces 1:1 to §2.4.
//      No field is added, none is omitted.
//
//   2) NAMED-ONLY projection types — Group 2 §2.4 references these by name
//      but gives no inline type literal. Per PR-6 directive §2 Ruling 1,
//      each is defined as a NAME-KEYED projection shape built only on
//      substrate data (GoldenProfile.critical_skills names from PR-4, the
//      PR-2/3 matching DTO's CriticalSkillExamination, and the persisted
//      Json columns). No skill_id keying, no invented per-skill metadata —
//      those belong to Group 3 (F15 / F18-supersedable).
//
// These types live in libs/examination because PR-6's projection is owned
// by the examination repository's read boundary. They are PR-6's TypeScript
// surface for the schema TalentJobExaminationFull defined in
// openapi/common.yaml (allOf TalentJobExaminationSummary + the additions).
//
// PR-6 is project-only (directive §2 Ruling 2): EvidenceReference values
// are returned as PR-3 persisted them; PR-6 does NOT query
// libs/talent-evidence to dereference targets.

import type { ExaminationLifecycleStateValue, ExaminationTierValue } from './examination.repository.js';

// =========================================================================
// FULLY-SPECIFIED — Group 2 §2.4 type literals, byte-faithful
// =========================================================================

// §2.4 ExaminationReasoning.category — 6-value closed enum (L1534-1542).
export type ExaminationReasoningCategory =
  | 'skill'
  | 'experience'
  | 'constraint'
  | 'freshness'
  | 'engagement'
  | 'risk';

// §2.4 EvidenceReference.entity_type — 8-value closed list (Group 2 L1622-1628
// / API Contracts EvidenceEntityType, byte-identical). The 8th value
// `TalentEngagementEvent` is deferred to M5 (PR-5 Ruling 1); references of
// that type are structurally valid but unresolvable until M5.
export type EvidenceEntityTypeValue =
  | 'TalentSkillEvidence'
  | 'TalentWorkHistoryEntry'
  | 'TalentContactMethod'
  | 'TalentRateExpectation'
  | 'TalentWorkAuthorization'
  | 'TalentEngagementEvent'
  | 'TalentDocument'
  | 'TalentDerivedSnapshot';

// §2.4 EvidenceReference — { entity_type, entity_id: UUID, field_path?,
// excerpt? } (Group 2 L1620-1634).
export interface EvidenceReference {
  entity_type: EvidenceEntityTypeValue;
  entity_id: string;
  field_path?: string;
  excerpt?: string;
}

// §2.4 ExaminationReasoning — { category, statement, evidence_refs:
// EvidenceReference[] } (Group 2 L1534-1546).
export interface ExaminationReasoning {
  category: ExaminationReasoningCategory;
  statement: string;
  evidence_refs: readonly EvidenceReference[];
}

// §2.4 RiskFlag.type — 8-value closed enum (Group 2 L1602-1610).
export type RiskFlagType =
  | 'unverified_contact'
  | 'stale_profile'
  | 'low_data_completeness'
  | 'conflicting_evidence'
  | 'rate_mismatch'
  | 'authorization_unknown'
  | 'low_reachability'
  | 'other';

// §2.4 RiskFlag.severity — 3-value closed enum (Group 2 L1612).
export type RiskFlagSeverity = 'low' | 'medium' | 'high';

// §2.4 RiskFlag — { type, subtype?, severity, message } (Group 2 L1600-1614).
export interface RiskFlag {
  type: RiskFlagType;
  subtype?: string;
  severity: RiskFlagSeverity;
  message: string;
}

// §2.4 ConfidenceIndicators.*.level — 3-value enum (Group 2 L1576-1580).
export type ConfidenceLevel = 'high' | 'medium' | 'low';

// §2.4 ConfidenceIndicators — three indicators, each { level, basis }
// (Group 2 L1574-1582).
export interface ConfidenceIndicator {
  level: ConfidenceLevel;
  basis: string;
}
export interface ConfidenceIndicators {
  evidence_strength: ConfidenceIndicator;
  data_completeness: ConfidenceIndicator;
  constraint_confidence: ConfidenceIndicator;
}

// §2.4 DeltaToEntrustable.current_tier — 2-value closed enum (Group 2 L1586).
export type DeltaCurrentTier = 'WORTH_CONSIDERING' | 'STRETCH';

// §2.4 DeltaToEntrustable.next_tier_target — 2-value closed enum
// (Group 2 L1588).
export type DeltaNextTierTarget = 'WORTH_CONSIDERING' | 'ENTRUSTABLE';

// §2.4 DeltaToEntrustable — { current_tier, next_tier_target, blockers,
// recommended_actions } (Group 2 L1586-1590).
export interface DeltaToEntrustable {
  current_tier: DeltaCurrentTier;
  next_tier_target: DeltaNextTierTarget;
  blockers: readonly string[];
  recommended_actions: readonly string[];
}

// =========================================================================
// NAMED-ONLY — PR-6-defined name-keyed projection shapes (Ruling 1)
// =========================================================================
//
// Group 2 §2.4 names these four (skill_match, experience_match,
// constraint_checks, freshness_indicator) but gives no inline type literal.
// PR-6 defines each as the simplest name-keyed shape that types the
// persisted Json honestly. No skill_id keying (would require reshaping
// GoldenProfile.critical_skills, deferred to Group 3 / F15). No invented
// per-skill metadata (level, weight, threshold) — also Group 3 territory.
// These shapes are Group-3-supersedable (F18).

// SkillMatchSummary — name-keyed skill-match breakdown over the job's
// critical skills. Per-skill view keyed by skill NAME (the value PR-4's
// GoldenProfile.critical_skills carries today). The per-skill fields
// (name, evidence_count, has_ingested_evidence) match exactly what the
// PR-2/3 matching DTO's CriticalSkillExamination carries — PR-6 forwards
// what the analysis layer already structures, no new metadata.
export interface SkillMatchSummaryPerSkill {
  name: string;
  evidence_count: number;
  has_ingested_evidence: boolean;
}
export interface SkillMatchSummary {
  matched_count: number;
  missing_count: number;
  per_skill: readonly SkillMatchSummaryPerSkill[];
}

// ExperienceMatchSummary — minimal projection over the persisted
// `experience_match` Json column. Group 2 names the type but specifies no
// inline body; the simplest honest typing of the persisted data is two
// optional fields (a years number and a free-text summary). Group 3 may
// supersede.
export interface ExperienceMatchSummary {
  years?: number;
  summary?: string;
}

// ConstraintCheckSummary — minimal projection over the persisted
// `constraint_checks` Json column. Field names match the four §2.5
// constraint dimensions (libs/matching's ConstraintChecksEvaluated):
// location, work_mode, rate, work_authorization. Each optional string
// because the persisted Json may carry any status text (pass/partial/
// fail/unknown per §2.5, or free-form per the analysis layer). Group 3 may
// supersede with a typed status enum.
export interface ConstraintCheckSummary {
  location?: string;
  work_mode?: string;
  rate?: string;
  work_authorization?: string;
}

// FreshnessIndicator — minimal projection over the persisted
// `freshness_indicator` Json column. Group 2 names it; the only inline
// reference in substrate is the PR-2/3 test fixture using
// `{ profile_age_days: number }`. PR-6's simplest honest projection.
// Group 3 may supersede with a richer shape (e.g. last-touched timestamps,
// per-dimension freshness scores).
export interface FreshnessIndicator {
  profile_age_days?: number;
}

// =========================================================================
// Projected views — the read-boundary types the projection method returns
// =========================================================================

// TalentJobExaminationSummaryView — the API Contracts v1.0 Summary shape
// (10 fields per §2.4). This is the OpenAPI `TalentJobExaminationSummary`
// schema's TypeScript counterpart; `Full` is `allOf` this + the additions.
//
// `top_skills` and `confidence_summary` are Summary-only projection shapes
// (the matching-list condensed view); they project from `skill_match` and
// `confidence_indicators` respectively. Like the named-only types in §2.4,
// they have no inline definition — defined here as minimal name-keyed
// projections (Ruling 1 spirit applied to Summary's projections too).
export interface TalentJobExaminationSummaryView {
  examination_id: string;
  talent_id: string;
  job_id: string;
  tier: ExaminationTierValue;
  rank_ordinal: number;
  why_matched_sentence: string;
  top_skills: readonly string[];
  confidence_summary: ConfidenceIndicators;
  freshness_indicator: FreshnessIndicator;
  computed_at: Date;
}

// TalentJobExaminationFullView — the API Contracts v1.0 Full shape
// (allOf Summary + the 5 additions named at L463-468):
//
//   - expanded_reasoning (Group 2 fully-specified)
//   - skill_match (named-only, PR-6-defined per Ruling 1)
//   - experience_match (named-only)
//   - constraint_checks (named-only)
//   - strengths, gaps (Group 2 fully-specified)
//   - risk_flags (Group 2 fully-specified)
//   - delta_to_entrustable (Group 2 fully-specified, optional per L1512)
//   - evidence_references (Group 2 fully-specified, the closed-list refs)
//   - lifecycle metadata (Group 2 fully-specified, already PR-1 columns)
//
// The `evidence_references` aggregate flattens the per-reasoning
// evidence_refs into a top-level list for Full's "complete evidence
// references" view (per API Contracts L437) — project-only, no
// dereferencing (Ruling 2).
export interface TalentJobExaminationFullView extends TalentJobExaminationSummaryView {
  expanded_reasoning: readonly ExaminationReasoning[];
  skill_match: SkillMatchSummary;
  experience_match: ExperienceMatchSummary;
  constraint_checks: ConstraintCheckSummary;
  strengths: readonly string[];
  gaps: readonly string[];
  risk_flags: readonly RiskFlag[];
  delta_to_entrustable: DeltaToEntrustable | null;
  evidence_references: readonly EvidenceReference[];
  lifecycle_state: ExaminationLifecycleStateValue;
  archived_at: Date | null;
  superseded_by_examination_id: string | null;
}
