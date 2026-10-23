import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  ExaminationRepository,
  type CreateExaminationSnapshotInput,
  type TalentJobExaminationRow,
} from '@aramo/examination';

import type { MatchingAnalysisInput } from './dto/matching-analysis-input.dto.js';
import {
  EXAMINATION_VERSION,
  MATCHING_MODEL_VERSION,
  TAXONOMY_VERSION,
} from './dto/version-pins.js';
import {
  evaluateEntrustability,
  type EntrustabilityExamination,
} from './engine.js';
import {
  DEFAULT_MATCHING_POLICY,
  MATCHING_POLICY_SOURCE,
  type MatchingPolicy,
  type MatchingPolicySource,
} from './matching-policy.js';

// MatchingService — M3 PR-2 §3.3 orchestrator.
//
// Takes a MatchingAnalysisInput, runs the pure §2.5 engine, derives
// delta_to_entrustable from the engine's failure categorization (§2.4),
// forwards the nine required Json analysis-product fields from the
// input contract into PR-1's ExaminationRepository.createSnapshot, and
// returns the persisted snapshot.
//
// The engine derives ONLY tier and delta_to_entrustable. Everything
// else is pass-through from the contract — the analysis-layer PR
// supplies the Json blobs, this service forwards them. PR-1's
// repository persists them opaquely (no shape validation on Json
// columns).
//
// Lifecycle: this service does NOT set lifecycle_state — PR-1's
// schema DB-defaults it to 'active'. archived_at and
// superseded_by_examination_id are also left unset at create time;
// they're lifecycle transitions a later PR will drive via PR-1's
// markSuperseded.

// §2.4 DeltaToEntrustable shape.
//   { current_tier, next_tier_target, blockers, recommended_actions }
// Only constructed when the tier is NOT ENTRUSTABLE — §2.5 "When
// entrustability fails, failed criteria populate delta_to_entrustable.
// blockers (2.4)."
interface DeltaToEntrustable {
  current_tier: 'WORTH_CONSIDERING' | 'STRETCH';
  next_tier_target: 'WORTH_CONSIDERING' | 'ENTRUSTABLE';
  blockers: readonly string[];
  recommended_actions: readonly string[];
}

function buildDeltaToEntrustable(
  examination: EntrustabilityExamination,
): DeltaToEntrustable | null {
  if (examination.tier === 'ENTRUSTABLE') {
    return null;
  }
  // §2.5 hard failures push tier to STRETCH; clearing them advances to
  // WORTH_CONSIDERING. Soft failures alone push to WORTH_CONSIDERING;
  // clearing them advances to ENTRUSTABLE.
  const next_tier_target =
    examination.tier === 'STRETCH' ? 'WORTH_CONSIDERING' : 'ENTRUSTABLE';
  const sourceFailures =
    examination.tier === 'STRETCH'
      ? examination.hard_failures
      : examination.soft_failures;
  return {
    current_tier: examination.tier,
    next_tier_target,
    blockers: sourceFailures.map((f) => f.criterion),
    recommended_actions: sourceFailures.map(
      (f) =>
        `Address ${f.criterion}: observed ${f.observed_value}, expected ${f.expected_threshold}`,
    ),
  };
}

@Injectable()
export class MatchingService {
  constructor(
    private readonly examinations: ExaminationRepository,
    // ATI-SEP-1 A2 A-c (P1) — the platform-owned MatchingPolicy port, bound at the
    // composition root (apps/api MatchingPolicyModule, @Global). @Optional so the lib
    // stays standalone: with no binding the compiled §2.5 defaults apply.
    @Optional()
    @Inject(MATCHING_POLICY_SOURCE)
    private readonly policySource?: MatchingPolicySource,
  ) {}

  // The policy the next examination runs with: the store's ACTIVE version, or the
  // compiled defaults when no source is bound or the store holds no ACTIVE version.
  // A store read error propagates (never a silent fallback to defaults).
  async resolvePolicy(): Promise<MatchingPolicy> {
    if (this.policySource === undefined) return DEFAULT_MATCHING_POLICY;
    return (await this.policySource.getActivePolicy()) ?? DEFAULT_MATCHING_POLICY;
  }

  // Pure-function projection — returns the engine result and the
  // engine-derived delta_to_entrustable without touching the DB. Useful
  // for callers that want to inspect the examination before deciding to
  // persist. The policy defaults to the compiled §2.5 calibration.
  evaluate(
    input: MatchingAnalysisInput,
    policy: MatchingPolicy = DEFAULT_MATCHING_POLICY,
  ): {
    examination: EntrustabilityExamination;
    delta_to_entrustable: DeltaToEntrustable | null;
  } {
    const examination = evaluateEntrustability(input, policy);
    const delta_to_entrustable = buildDeltaToEntrustable(examination);
    return { examination, delta_to_entrustable };
  }

  // Evaluates the input under the ACTIVE platform MatchingPolicy and persists the
  // result as a TalentJobExamination snapshot via PR-1's ExaminationRepository
  // (§3.3). All nine required Json analysis-product fields are forwarded from the
  // input contract; the three §3.4 version pins are supplied here from typed
  // constants.
  async evaluateAndPersist(
    input: MatchingAnalysisInput,
  ): Promise<TalentJobExaminationRow> {
    const policy = await this.resolvePolicy();
    const { examination, delta_to_entrustable } = this.evaluate(input, policy);

    const snapshotInput: CreateExaminationSnapshotInput = {
      // identity (forwarded)
      id: input.id,
      tenant_id: input.tenant_id,
      talent_id: input.talent_id,
      job_id: input.job_id,
      golden_profile_id: input.golden_profile_id,

      // engine-derived
      tier: examination.tier,
      delta_to_entrustable,

      // forwarded engine-pinned
      trigger: input.trigger,
      rank_ordinal: input.rank_ordinal,
      computed_at: input.computed_at,

      // forwarded recruiter-facing scalars
      why_matched_sentence: input.why_matched_sentence,
      match_summary: input.match_summary,

      // forwarded nine §2.4 Json analysis-product fields (§3.3)
      expanded_reasoning: input.expanded_reasoning,
      skill_match: input.skill_match,
      experience_match: input.experience_match,
      constraint_checks: input.constraint_checks,
      strengths: input.strengths,
      gaps: input.gaps,
      risk_flags: input.risk_flags,
      confidence_indicators: input.confidence_indicators,
      freshness_indicator: input.freshness_indicator,

      // §3.4 version pins from typed constants
      examination_version: EXAMINATION_VERSION,
      model_version: MATCHING_MODEL_VERSION,
      taxonomy_version: TAXONOMY_VERSION,
    };

    return this.examinations.createSnapshot(snapshotInput);
  }
}
