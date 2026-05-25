import type { TalentEngagementEventView } from './talent-engagement-event.view.js';

// M5 PR-4 §4.2 — HTTP response DTO for
// GET /v1/engagements/{id}/events 200.
//
// Returns the chronological event log for an engagement. Order: ASC by
// created_at (mirrors EngagementEventRepository.findByEngagementId
// repository-layer ordering).
export interface EngagementListEventsResponseDto {
  events: TalentEngagementEventView[];
}
