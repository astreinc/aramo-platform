// M4 PR-3 §4.3 — typed view projection for TalentSubmittalRecord.
//
// The Prisma model stores `failed_criterion_acknowledgments` as nullable
// JSONB; the repository projects it through this typed shape at the
// read boundary. Mirrors PR-1's pattern for TalentJobEvidencePackage:
// the JSONB column is stored opaquely; the cast is the read-side type
// assertion only.

import type { TalentIdentity, ContactSummary, CapabilitySummaryOverrides, MatchJustificationOverrides, RecruiterContributionInput } from '@aramo/evidence';

// SubmittalState — value type mirroring the Prisma enum
// (libs/submittal/prisma/schema.prisma). 2-value subset of Group 2 §2.3b
// Loop 5's 5-state machine; F37 extends at M5.
export type SubmittalStateValue = 'draft' | 'submitted';

// §2.6 FailedCriterionAcknowledgment — Worth Considering submittal
// support. Schema mirrors API Contracts Phase 2 verbatim block; the
// builder persists this verbatim into JSONB. F34 enforces non-empty
// when tier is Worth Considering.
export interface FailedCriterionAcknowledgment {
  criterion: string;
  field_path: string;
  observed_value: string;
  expected_threshold: string;
  acknowledged: boolean;
}

// TalentSubmittalRecordView — read projection over the Prisma row.
export interface TalentSubmittalRecordView {
  id: string;
  tenant_id: string;
  talent_id: string;
  job_id: string;
  evidence_package_id: string;
  pinned_examination_id: string;
  state: SubmittalStateValue;
  created_by: string;
  justification: string | null;
  failed_criterion_acknowledgments: readonly FailedCriterionAcknowledgment[] | null;
  created_at: Date;
  confirmed_at: Date | null;
}

// CreateSubmittalInput — the controller-layer input that flows into
// SubmittalRepository.createSubmittal. The repository orchestrates the
// evidence-package build (via @aramo/evidence's buildPackage) and the
// TalentSubmittalRecord write.
//
// Mirrors PR-2's BuildPackageInput shape minus the identity columns
// the submittal layer owns (id is server-generated; submittal_record_id
// is set by the repository post-create on the evidence package).
export interface CreateSubmittalInput {
  // Identity (caller-provided from JWT context)
  tenant_id: string;
  talent_id: string;
  job_id: string;
  created_by: string;

  // Cross-schema reference
  examination_id: string;

  // Evidence-package recruiter-authored payloads (forwarded to
  // EvidenceRepository.buildPackage verbatim).
  talent_identity: TalentIdentity;
  contact_summary: ContactSummary;
  capability_summary_overrides: CapabilitySummaryOverrides;
  match_justification_overrides?: MatchJustificationOverrides;
  recruiter_contribution: RecruiterContributionInput;
  rate_expectation_id?: string | null;
  engagement_event_refs?: readonly string[];

  // Worth Considering optional fields — accepted at PR-3, persisted
  // verbatim, NOT enforced. F34 enforces.
  justification?: string;
  failed_criterion_acknowledgments?: readonly FailedCriterionAcknowledgment[];
}
