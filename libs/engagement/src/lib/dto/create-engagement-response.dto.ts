import type { TalentSelectionView as TalentJobEngagementView } from '@aramo/selection';

// M5 PR-4 §4.2 — HTTP response DTO for POST /v1/selections 201.
//
// Per Ruling 9: response shape is { engagement } only (NOT { engagement,
// event }). Repository-layer CreateEngagementResult returns both rows;
// the controller projects only the engagement view to the HTTP boundary.
// The initial event row is accessible via subsequent GET
// /v1/selections/{id}/events.
export interface CreateEngagementResponseDto {
  engagement: TalentJobEngagementView;
}
