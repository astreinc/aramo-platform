// Hand-mirrored from libs/submittal/src/lib/submittal-state.ts and
// libs/submittal/src/lib/dto/*. R6 hand-mirrors instead of importing
// @aramo/submittal (a forbidden domain edge per the FE foundation
// discipline). The state machine is mirrored in ./submittal-state.ts
// and guarded by ./submittal-state-drift.spec.ts.

// SubmittalStateValue — canonical 6-state machine (5 mainline + revoked).
// Source: libs/submittal/src/lib/submittal-state.ts SUBMITTAL_STATE_VALUES.
export const SUBMITTAL_STATE_VALUES = [
  'created',
  'handoff_draft',
  'ready_for_review',
  'submitted_to_ats',
  'confirmed',
  'revoked',
] as const;
export type SubmittalStateValue = (typeof SUBMITTAL_STATE_VALUES)[number];

// Display labels for the wizard step UI.
export const SUBMITTAL_STATE_LABELS: Record<SubmittalStateValue, string> = {
  created: 'Created',
  handoff_draft: 'Handoff draft',
  ready_for_review: 'Ready for review',
  submitted_to_ats: 'Submitted to ATS',
  confirmed: 'Confirmed',
  revoked: 'Revoked',
};

// The 5 wizard steps the recruiter walks (revoked is shown inline as a
// terminal "this submittal was revoked" state, NOT a wizard step).
export const WIZARD_STEPS: readonly SubmittalStateValue[] = [
  'created',
  'handoff_draft',
  'ready_for_review',
  'submitted_to_ats',
  'confirmed',
];

// TalentSubmittalRecordView — hand-mirrored from
// libs/submittal/src/lib/dto/talent-submittal-record.view.ts (the projected
// view shape returned by every submittal endpoint). The nested overrides
// + recruiter_contribution shapes are out-of-scope for the wizard UI; we
// model only the workflow-visible surface.
export interface TalentSubmittalRecordView {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly job_id: string;
  readonly evidence_package_id: string;
  readonly pinned_examination_id: string;
  readonly state: SubmittalStateValue;
  readonly created_by: string;
  readonly justification: string | null;
  readonly failed_criterion_acknowledgments: readonly unknown[] | null;
  readonly created_at: string;
  readonly confirmed_at: string | null;
  readonly revoked_at: string | null;
  readonly revoked_by: string | null;
  readonly revocation_justification: string | null;
}

// Create payload — hand-mirrored from CreateSubmittalRequestDto. We pass
// the structured nested payloads opaquely (the wizard's create step
// renders identity + capability summary + recruiter contribution form
// fields, then assembles this shape).
export interface CreateSubmittalRequest {
  readonly talent_id: string;
  readonly job_id: string;
  readonly examination_id: string;
  readonly talent_identity: TalentIdentityPayload;
  readonly contact_summary: ContactSummaryPayload;
  readonly capability_summary_overrides: CapabilitySummaryOverridesPayload;
  readonly recruiter_contribution: RecruiterContributionPayload;
  readonly justification?: string;
  readonly failed_criterion_acknowledgments?: readonly FailedCriterionAcknowledgment[];
}

export interface TalentIdentityPayload {
  readonly full_name: string;
  readonly preferred_name?: string;
  readonly location: string;
}

export interface ContactSummaryPayload {
  readonly contact_available: boolean;
  readonly channels_verified: readonly string[];
}

export interface CapabilitySummaryOverridesPayload {
  readonly key_work_history: readonly WorkHistoryEntry[];
  readonly certifications?: readonly string[];
}

export interface WorkHistoryEntry {
  readonly employer_name: string;
  readonly role_title: string;
  readonly start_date: string;
  readonly end_date?: string;
}

export interface RecruiterContributionPayload {
  readonly screening_notes?: string;
  readonly conversation_summary: { readonly recruiter_summary: string };
  readonly talent_confirmed: { readonly spoken_to_recruiter: boolean };
}

export interface FailedCriterionAcknowledgment {
  readonly criterion_id: string;
  readonly acknowledgment: string;
}

// The 3 attestations the /confirm endpoint requires. All literal-true.
// The wizard form START-UNCHECKED — the recruiter must affirmatively
// check each before the Confirm button enables.
export interface RecruiterAttestations {
  readonly talent_evidence_reviewed: boolean;
  readonly constraints_reviewed: boolean;
  readonly submittal_risk_acknowledged: boolean;
}

// Lookup response shape (R6 — GET /v1/submittals?talent_id=&job_id=).
export interface SubmittalLookupResponse {
  readonly submittal: TalentSubmittalRecordView | null;
}

// Create/confirm/mark-ready/submit-to-ats/confirm-ats/revoke response
// shapes — all wrap the submittal view.
export interface SubmittalResponse {
  readonly submittal: TalentSubmittalRecordView;
}

export interface SubmittalRevokeResponse {
  readonly submittal: TalentSubmittalRecordView;
  readonly evidence_package_mutated: false;
}

// Evidence package view — hand-mirrored from
// libs/evidence/src/lib/dto/talent-job-evidence-package.view.ts (the
// fields the Confirmed step displays). The deep payloads are rendered
// opaquely as JSON.
export interface EvidencePackageView {
  readonly id: string;
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly job_id: string;
  readonly examination_id: string;
  readonly talent_identity: Record<string, unknown>;
  readonly contact_summary: Record<string, unknown>;
  readonly capability_summary: Record<string, unknown>;
  readonly match_justification: Record<string, unknown>;
  readonly recruiter_contribution: Record<string, unknown>;
  readonly created_at: string;
}

// Match-list summary (the FE's path to discover examination_id for a
// (talent, job) pair). Hand-mirrored from
// libs/examination/src/lib/examination-full.types.ts
// TalentJobExaminationSummaryView's wizard-relevant fields.
export interface MatchListResponse {
  readonly data: readonly MatchListSummary[];
  readonly pagination: {
    readonly cursor: string | null;
    readonly next_cursor: string | null;
    readonly page_size: number;
    readonly has_more: boolean;
  };
}

export interface MatchListSummary {
  readonly examination_id: string;
  readonly talent_id: string;
  readonly job_id: string;
  readonly tier: 'ENTRUSTABLE' | 'WORTH_CONSIDERING' | 'STRETCH';
  readonly rank_ordinal: number;
}
