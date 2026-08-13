import type { TalentSelectionEventView } from './talent-selection-event.view.js';

// M5 PR-4 §4.2 — HTTP response DTO for
// GET /v1/selections/{id}/events 200.
//
// Returns the chronological event log for an selection. Order: ASC by
// created_at (mirrors SelectionEventRepository.findBySelectionId
// repository-layer ordering).
export interface SelectionListEventsResponseDto {
  events: TalentSelectionEventView[];
}
