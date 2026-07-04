// Promotion Gate — Slice A constants.

// Reserved system/pipeline actor for promotion-created TalentRecords
// (Amendment v1.1 §2.2). Promotion is automated — the record is attributed to
// this reserved actor, NOT a human recruiter. `entered_by_id` is a nullable
// @db.Uuid with NO foreign key (STEP-0 confirmed), so a reserved constant is
// safe (no referential violation). Distinct, stable, and recognizable.
export const PROMOTION_SYSTEM_ACTOR_ID =
  '00000000-0000-4000-8000-00000000c0de' as const;

// Provenance stamped on the ATS_TALENT_RECORD ResolutionSubjectRef the
// promotion attaches (link_source) — records that the L2→L3 link was minted by
// the create branch of the promotion gate.
export const PROMOTION_LINK_SOURCE = 'promotion-gate-create' as const;
