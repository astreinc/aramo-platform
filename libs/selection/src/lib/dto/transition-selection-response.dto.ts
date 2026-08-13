import type { TalentSelectionView } from './talent-selection.view.js';

// M5 PR-4 §4.2 — HTTP response DTO for
// POST /v1/selections/{id}/transitions 200.
//
// Per Ruling 9 + Ruling 11: response shape is { selection } only. NO
// state-isolation literal field (selection_unrelated_columns_mutated)
// per Ruling 11 — the column-scoped immutability trigger at the DB
// layer (PR-1 substrate) enforces the invariant; HTTP contract
// affirmation is omitted for response noise reduction.
export interface TransitionSelectionResponseDto {
  selection: TalentSelectionView;
}
