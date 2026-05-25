import type { TalentJobEngagementView } from './talent-job-engagement.view.js';

// M5 PR-4 §4.2 — HTTP response DTO for
// POST /v1/engagements/{id}/transitions 200.
//
// Per Ruling 9 + Ruling 11: response shape is { engagement } only. NO
// state-isolation literal field (engagement_unrelated_columns_mutated)
// per Ruling 11 — the column-scoped immutability trigger at the DB
// layer (PR-1 substrate) enforces the invariant; HTTP contract
// affirmation is omitted for response noise reduction.
export interface TransitionEngagementResponseDto {
  engagement: TalentJobEngagementView;
}
