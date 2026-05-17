// Version pins introduced by M3 PR-2 §3.4 as typed constants in
// libs/matching. There is no skills-taxonomy version source on substrate
// (the §8.1-B pass confirmed libs/skills-taxonomy is empty scaffolding),
// so all three snapshot version pins are greenfield here. PR-2 introduces
// them as constants — a database-backed version registry is explicitly
// deferred (directive §4).
//
// MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION is the seam between the engine
// and the later matching-analysis PR; it couples to §3.1 (the input
// contract carries a version identifier).
//
// EXAMINATION_VERSION, MATCHING_MODEL_VERSION, and TAXONOMY_VERSION are
// the three §2.4 snapshot pins the engine supplies at createSnapshot
// time. PR-1's TalentJobExamination columns are NOT NULL and the
// column-scoped immutability trigger rejects any post-create change to
// them, so these constants pin every snapshot the engine writes.

export const MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION = 'matching-input-v1.0.0' as const;

export const EXAMINATION_VERSION = 'examination-v1.0.0' as const;

export const MATCHING_MODEL_VERSION = 'matching-model-v1.0.0' as const;

export const TAXONOMY_VERSION = 'taxonomy-v1.0.0' as const;
