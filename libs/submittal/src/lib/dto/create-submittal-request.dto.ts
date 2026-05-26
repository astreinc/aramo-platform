// M4 PR-3 §4.4 — HTTP request/response DTOs for POST /v1/submittals.
//
// Mirrors PR-2's BuildPackageInput shape but at the HTTP boundary. The
// controller layer takes this DTO, derives tenant_id + created_by from
// the JWT auth context, and forwards a CreateSubmittalInput to the
// repository.

import type {
  TalentIdentity,
  ContactSummary,
  CapabilitySummaryOverrides,
  MatchJustificationOverrides,
  RecruiterContributionInput,
} from '@aramo/evidence';

import type {
  FailedCriterionAcknowledgment,
  TalentSubmittalRecordView,
} from './talent-submittal-record.view.js';

// CreateSubmittalRequestDto — the body shape for POST /v1/submittals.
// The talent + job identification flows from the request body; tenant +
// recruiter identity flow from the JWT (NOT in the body).
export interface CreateSubmittalRequestDto {
  talent_id: string;
  job_id: string;
  examination_id: string;
  talent_identity: TalentIdentity;
  contact_summary: ContactSummary;
  capability_summary_overrides: CapabilitySummaryOverrides;
  match_justification_overrides?: MatchJustificationOverrides;
  recruiter_contribution: RecruiterContributionInput;
  rate_expectation_id?: string | null;
  engagement_event_refs?: readonly string[];
  // Worth Considering optional fields — accepted at PR-3, NOT enforced
  // (F34 enforces against the examination's tier).
  justification?: string;
  failed_criterion_acknowledgments?: readonly FailedCriterionAcknowledgment[];
}

// CreateSubmittalResponseDto — 201 response shape. Returns the freshly
// created TalentSubmittalRecord (carrying state='created' on first create per M5 PR-8b2 rename)
// alongside the evidence_package_id that the consuming endpoints
// (GET /v1/submittals/{id}/evidence-package — future PR) will resolve.
export interface CreateSubmittalResponseDto {
  submittal: TalentSubmittalRecordView;
}
