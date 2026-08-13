import type { TalentSelectionView } from './talent-selection.view.js';

// M5 PR-4 §4.2 — HTTP response DTO for POST /v1/selections 201.
//
// Per Ruling 9: response shape is { selection } only (NOT { selection,
// event }). Repository-layer CreateSelectionResult returns both rows;
// the controller projects only the selection view to the HTTP boundary.
// The initial event row is accessible via subsequent GET
// /v1/selections/{id}/events.
export interface CreateSelectionResponseDto {
  selection: TalentSelectionView;
}
