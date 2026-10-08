import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the Talent-evidence entities (M3 PR-5).
//
// Surface scope (closed, per the PR-1 / PR-4 entity-foundation precedent):
//   - createTalentSkillEvidence / findTalentSkillEvidenceById
//   - createTalentWorkHistoryEntry / findTalentWorkHistoryEntryById
//   - createTalentContactMethod / findTalentContactMethodById
//   - createTalentRateExpectation / findTalentRateExpectationById
//   - createTalentWorkAuthorization / findTalentWorkAuthorizationById
//   - createTalentDocument / findTalentDocumentById
//   - createTalentDerivedSnapshot / findTalentDerivedSnapshotById
//
// Read-and-create only. No update / delete / list / filter methods are
// exposed — those are speculative until a consumer (PR-6 reasoning +
// evidence linkage) arrives with a concrete read pattern.
//
// Cross-schema rule (Architecture v2.1 §7.3): every `*_id` field on every
// entity is a plain UUID column with no foreign key. The repository
// accepts the UUIDs verbatim and persists them without referential
// validation; the application layer is responsible for the referenced
// values being correct.
//
// Json columns (on TalentDerivedSnapshot) carry shape per Group 2 §2.2.
// The repository accepts any JSON-serialisable value (`unknown`) and
// forwards it to Prisma opaquely — the same opaque-Json pattern PR-1's
// ExaminationRepository uses for its analytical fields.

type JsonInput = unknown;

// ---- Enum value types (mirror Prisma's generated enums) ---------------

export type TalentSkillEvidenceSourceValue = 'declared' | 'ingested' | 'derived';

export type TalentWorkHistorySourceValue = 'resume' | 'linkedin' | 'manual' | 'import';
// TR-7 B1 — the education/certification source vocabularies (resume/manual/import).
export type TalentEducationSourceValue = 'resume' | 'manual' | 'import';
export type TalentCertificationSourceValue = 'resume' | 'manual' | 'import';

export type TalentContactTypeValue =
  | 'email'
  | 'phone'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'other';

export type TalentContactVerificationStatusValue =
  | 'unverified'
  | 'verified'
  | 'failed'
  | 'stale';

// The TS literal type uses the spec values "W2" | "1099" | "C2C" | "FTE".
// The Prisma client identifier for "1099" is CONTRACT_1099 (the schema's
// @map("1099") maps it to the DB literal "1099"); the repository accepts
// the spec literal and translates internally.
export type TalentEmploymentTypeValue = 'W2' | '1099' | 'C2C' | 'FTE';

export type TalentRatePeriodValue = 'HOURLY' | 'ANNUAL';

export type TalentRateSourceValue = 'talent_declared' | 'recruiter_entered';

export type TalentWorkAuthorizationStatusValue =
  | 'US_CITIZEN'
  | 'PERMANENT_RESIDENT'
  | 'VISA_HOLDER'
  | 'REQUIRES_SPONSORSHIP'
  | 'OTHER'
  | 'NOT_DISCLOSED';

export type TalentDocumentTypeValue =
  | 'resume'
  | 'cover_letter'
  | 'certification'
  | 'work_sample'
  | 'reference_letter'
  | 'other';

export type TalentDocumentParseStatusValue =
  | 'pending'
  | 'parsed'
  | 'failed'
  | 'no_parse_attempted';

export type TalentDocumentRetentionPolicyValue =
  | 'default'
  | 'extended'
  | 'delete_after_X_days';

// ---- TalentSkillEvidence (Group 2 §2.2 #16) ----------------------------

export interface CreateTalentSkillEvidenceInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_id: string;
  source_record_id?: string;
  surface_form: string;
  source: TalentSkillEvidenceSourceValue;
  evidence_text?: string;
  proficiency_claim?: string;
  years_claimed?: number;
  confidence_score?: number;
  // HF1 provenance (Gate-6 R1/R2) — additive nullable; populated only on the
  // confirmed-create resume path. source_refs defaults to [] when unknown.
  source_document_id?: string;
  source_refs?: string[];
  source_map_version?: string;
  resume_text_hash?: string;
  // HF2 R3/R16 — time-aware per-experience skill usage (additive nullable).
  work_experience_id?: string;
  version?: string;
  usage_start?: Date;
  usage_end?: Date;
  usage_period_basis?: string;
  activity_context?: string;
  created_at: Date;
}

export interface TalentSkillEvidenceRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_id: string;
  source_record_id: string | null;
  surface_form: string;
  source: TalentSkillEvidenceSourceValue;
  evidence_text: string | null;
  proficiency_claim: string | null;
  years_claimed: number | null;
  confidence_score: number | null;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  work_experience_id: string | null;
  version: string | null;
  usage_start: Date | null;
  usage_end: Date | null;
  usage_period_basis: string | null;
  activity_context: string | null;
  created_at: Date;
}

// ---- TalentWorkHistoryEntry (Group 2 §2.2 #10) -------------------------

export interface CreateTalentWorkHistoryEntryInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  employer_name: string;
  role_title: string;
  start_date?: Date;
  end_date?: Date;
  location?: string;
  employment_type?: string;
  description_text?: string;
  source: TalentWorkHistorySourceValue;
  source_document_id?: string;
  // HF1 provenance (Gate-6 R1/R8) — additive nullable; source_refs defaults to [].
  source_refs?: string[];
  source_map_version?: string;
  resume_text_hash?: string;
  // HF2 R2/R10 — WorkExperience extension (additive nullable).
  company_id?: string;
  experience_summary?: string;
  is_authoritative?: boolean;
  created_at: Date;
}

export interface TalentWorkHistoryEntryRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  employer_name: string;
  role_title: string;
  start_date: Date | null;
  end_date: Date | null;
  location: string | null;
  employment_type: string | null;
  description_text: string | null;
  source: TalentWorkHistorySourceValue;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  company_id: string | null;
  experience_summary: string | null;
  is_authoritative: boolean | null;
  created_at: Date;
}

// ---- TR-7 B1 — TalentEducationEntry / TalentCertificationEntry ----------

export interface CreateTalentEducationEntryInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  institution_name: string;
  degree_name: string;
  field_of_study?: string;
  conferred_date?: Date;
  evidence_text?: string;
  source: TalentEducationSourceValue;
  // HF2 R8 — HF1-style provenance (additive nullable).
  source_document_id?: string;
  source_refs?: string[];
  source_map_version?: string;
  resume_text_hash?: string;
  created_at: Date;
}

export interface TalentEducationEntryRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  institution_name: string;
  degree_name: string;
  field_of_study: string | null;
  conferred_date: Date | null;
  evidence_text: string | null;
  source: TalentEducationSourceValue;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  created_at: Date;
}

export interface CreateTalentCertificationEntryInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  certification_name: string;
  issuer_name?: string;
  credential_ref?: string;
  issued_date?: Date;
  expiry_date?: Date;
  evidence_text?: string;
  source: TalentCertificationSourceValue;
  // HF2 R8 — HF1-style provenance (additive nullable).
  source_document_id?: string;
  source_refs?: string[];
  source_map_version?: string;
  resume_text_hash?: string;
  created_at: Date;
}

export interface TalentCertificationEntryRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  certification_name: string;
  issuer_name: string | null;
  credential_ref: string | null;
  issued_date: Date | null;
  expiry_date: Date | null;
  evidence_text: string | null;
  source: TalentCertificationSourceValue;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  created_at: Date;
}

// ---- HF2 R6 — TalentProjectExperience (child of a WorkExperience) --------

export interface CreateTalentProjectExperienceInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_experience_id: string;
  project_name?: string;
  context_summary?: string;
  domain?: string;
  start_date?: Date;
  end_date?: Date;
  source_document_id?: string;
  source_refs?: string[];
  source_map_version?: string;
  resume_text_hash?: string;
  created_at: Date;
}

export interface TalentProjectExperienceRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_experience_id: string;
  project_name: string | null;
  context_summary: string | null;
  domain: string | null;
  start_date: Date | null;
  end_date: Date | null;
  source_document_id: string | null;
  source_refs: string[];
  source_map_version: string | null;
  resume_text_hash: string | null;
  created_at: Date;
}

// ---- TalentContactMethod (Group 2 §2.2 #4) -----------------------------

export interface CreateTalentContactMethodInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  type: TalentContactTypeValue;
  value: string;
  is_primary: boolean;
  verification_status: TalentContactVerificationStatusValue;
  verified_at?: Date;
  created_at: Date;
}

export interface TalentContactMethodRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  type: TalentContactTypeValue;
  value: string;
  is_primary: boolean;
  verification_status: TalentContactVerificationStatusValue;
  verified_at: Date | null;
  created_at: Date;
}

// ---- TalentRateExpectation (Group 2 §2.2 #7) ---------------------------

export interface CreateTalentRateExpectationInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  employment_type: TalentEmploymentTypeValue;
  min_rate: number;
  target_rate?: number;
  currency: string;
  period: TalentRatePeriodValue;
  source: TalentRateSourceValue;
  updated_at: Date;
}

export interface TalentRateExpectationRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  employment_type: TalentEmploymentTypeValue;
  min_rate: number;
  target_rate: number | null;
  currency: string;
  period: TalentRatePeriodValue;
  source: TalentRateSourceValue;
  updated_at: Date;
}

// ---- TalentWorkAuthorization (Group 2 §2.2 #6 — Declared (Sensitive)) --

export interface CreateTalentWorkAuthorizationInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_authorization_status: TalentWorkAuthorizationStatusValue;
  authorized_to_work_in: readonly string[];
  visa_type?: string;
  requires_sponsorship: boolean;
  updated_at: Date;
  // TI-1G §2 — temporal (all optional; DB defaults asserted_at to now()).
  // effective_from/to + expires_at are set ONLY when explicitly supplied.
  asserted_at?: Date;
  effective_from?: Date;
  effective_to?: Date;
  expires_at?: Date;
}

export interface TalentWorkAuthorizationRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  work_authorization_status: TalentWorkAuthorizationStatusValue;
  authorized_to_work_in: string[];
  visa_type: string | null;
  requires_sponsorship: boolean;
  updated_at: Date;
  // TI-1G §2 — temporal/current-state.
  asserted_at: Date;
  effective_from: Date | null;
  effective_to: Date | null;
  expires_at: Date | null;
}

// ---- TalentDocument (Group 2 §2.2 #8) ----------------------------------

export interface CreateTalentDocumentInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  uploaded_by_actor_id: string;
  uploaded_at: Date;
  document_type: TalentDocumentTypeValue;
  filename: string;
  file_storage_ref: string;
  mime_type: string;
  size_bytes: number;
  parse_status: TalentDocumentParseStatusValue;
  consent_scope_at_upload: readonly string[];
  retention_policy: TalentDocumentRetentionPolicyValue;
  is_active: boolean;
  // Resume Revision Lifecycle §4 — real artifact byte SHA-256 for the canonical
  // DocumentRevision/DocumentArtifact (replaces the 'unknown' placeholder).
  artifact_sha256?: string;
}

// DOC-1b — TalentDocument is now a Talent-specific projection over the canonical
// documents.Document (linked by document_id). The GENERIC file metadata
// (uploaded_by_actor_id, uploaded_at, document_type, filename, file_storage_ref,
// mime_type, size_bytes) moved to documents.Document/Revision/Artifact and was
// dropped from this row; readers source it from documents via document_id.
export interface TalentDocumentRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  parse_status: TalentDocumentParseStatusValue;
  consent_scope_at_upload: string[];
  retention_policy: TalentDocumentRetentionPolicyValue;
  is_active: boolean;
  document_id: string | null;
}

// ---- TalentResumeEdition / TalentResumeDefault (TALENT-INTEL-1 §5) ----------

export type TalentResumeEditionPurposeValue =
  | 'GENERAL'
  | 'ROLE_FAMILY'
  | 'REQUISITION'
  | 'CLIENT_SUBMITTAL'
  | 'USER_DEFINED';

export type TalentResumeEditionLifecycleValue = 'active' | 'retracted' | 'archived';

export interface CreateTalentResumeEditionInput {
  id: string;
  tenant_id: string;
  talent_id: string;
  talent_document_id: string;
  content_hash: string;
  created_at: Date;
  created_by: string;
  // Resume Revision Lifecycle §4 — the authoritative artifact byte SHA-256
  // (exact-duplicate key). NULLABLE — omitted ⇒ legacy/hashless edition.
  artifact_sha256?: string;
  // Optional context / lineage (all NULLABLE).
  attachment_id?: string;
  purpose?: TalentResumeEditionPurposeValue; // omitted ⇒ GENERAL (DB default)
  label?: string;
  requisition_id?: string;
  client_context_id?: string;
  derived_from_edition_id?: string;
  lifecycle_status?: TalentResumeEditionLifecycleValue; // omitted ⇒ active
}

export interface TalentResumeEditionRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  talent_document_id: string;
  attachment_id: string | null;
  content_hash: string;
  artifact_sha256: string | null;
  purpose: TalentResumeEditionPurposeValue;
  label: string | null;
  requisition_id: string | null;
  client_context_id: string | null;
  derived_from_edition_id: string | null;
  lifecycle_status: TalentResumeEditionLifecycleValue;
  created_at: Date;
  created_by: string;
}

export interface SetTalentResumeDefaultInput {
  id: string;
  tenant_id: string;
  talent_id: string;
  resume_edition_id: string;
  set_at: Date;
  set_by: string;
}

export interface TalentResumeDefaultRow {
  id: string;
  tenant_id: string;
  talent_id: string;
  resume_edition_id: string;
  set_at: Date;
  set_by: string;
}

// TALENT-INTEL-1 (TI-1F-A) — the durable governed-extraction REVIEW draft.
export type ResumeExtractionDraftSourceKindValue = 'CREATE_DRAFT_UPLOAD' | 'ATTACHMENT';
export type ResumeExtractionDraftStatusValue =
  | 'PROCESSING'
  | 'READY_FOR_REVIEW'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'FAILED';

// Enqueue/persist a draft. Idempotent on the durable source identity
// (tenant_id, source_kind, source_ref). talent_id / document / edition are
// omitted (NULL) for a pre-Talent CREATE_DRAFT_UPLOAD draft.
export interface UpsertResumeExtractionDraftInput {
  id: string;
  tenant_id: string;
  source_kind: ResumeExtractionDraftSourceKindValue;
  source_ref: string;
  talent_id?: string | null;
  talent_document_id?: string | null;
  resume_edition_id?: string | null;
  status: ResumeExtractionDraftStatusValue;
  structured_payload?: unknown;
  source_map_version?: string | null;
  resume_text_hash?: string | null;
  extractor_version?: string | null;
  created_at: Date;
  created_by: string;
}

export interface ResumeExtractionDraftRow {
  id: string;
  tenant_id: string;
  source_kind: ResumeExtractionDraftSourceKindValue;
  source_ref: string;
  talent_id: string | null;
  talent_document_id: string | null;
  resume_edition_id: string | null;
  status: ResumeExtractionDraftStatusValue;
  structured_payload: unknown;
  source_map_version: string | null;
  resume_text_hash: string | null;
  extractor_version: string | null;
  attempt_count: number;
  last_error_code: string | null;
  last_error_at: Date | null;
  created_at: Date;
  created_by: string;
  reviewed_at: Date | null;
  reviewed_by: string | null;
}

// TALENT-INTEL-1 TI-1D-C — an edition projected WITH its TalentDocument metadata
// (file_type/ingestion_at derived from the mandatory talent_document_id join, NOT
// stored on the edition — ruling E) and its default marker. filename/mime_type/
// uploaded_at are PROJECTED from TalentDocument, never copied into the edition row.
export interface TalentResumeEditionWithDocumentRow extends TalentResumeEditionRow {
  document_filename: string;
  document_mime_type: string;
  document_uploaded_at: Date;
  is_default: boolean;
  // TI-1F-A — DERIVED from the edition's ResumeExtractionDraft (governed
  // extraction lifecycle). NULL for editions with no draft (pre-TI-1F-A).
  processing_status: ResumeExtractionDraftStatusValue | null;
}

// ---- TalentDerivedSnapshot (Group 2 §2.2 #17) --------------------------

export interface CreateTalentDerivedSnapshotInput {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_confidence_scores: JsonInput;
  estimated_years_experience_overall?: number;
  estimated_years_experience_by_skill?: JsonInput;
  // SKILL-TAX-1G — canonical (interval-union) supported-years, keyed by
  // canonical_skill_id. Additive; the legacy by_skill field is preserved.
  estimated_years_experience_by_canonical_skill?: JsonInput;
  skill_domains?: JsonInput;
  career_trajectory_pattern?: string;
  intent_signal?: JsonInput;
  freshness_score?: JsonInput;
  reachability_score?: JsonInput;
  availability_confidence?: number;
  trust_level?: string;
  data_completeness_score?: number;
  threshold_status?: JsonInput;
  current_consent_state?: JsonInput;
  computed_at: Date;
}

export interface TalentDerivedSnapshotRow {
  id: string;
  talent_id: string;
  tenant_id: string;
  skill_confidence_scores: unknown;
  estimated_years_experience_overall: number | null;
  estimated_years_experience_by_skill: unknown;
  estimated_years_experience_by_canonical_skill: unknown;
  skill_domains: unknown;
  career_trajectory_pattern: string | null;
  intent_signal: unknown;
  freshness_score: unknown;
  reachability_score: unknown;
  availability_confidence: number | null;
  trust_level: string | null;
  data_completeness_score: number | null;
  threshold_status: unknown;
  current_consent_state: unknown;
  computed_at: Date;
}

// Maps the spec literal value to the Prisma enum identifier. Spec literal
// "1099" requires translation because Prisma identifier rules forbid leading
// digits; the schema's @map("1099") makes the DB column store "1099".
const EMPLOYMENT_TYPE_TO_PRISMA: Record<TalentEmploymentTypeValue, 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE'> = {
  W2: 'W2',
  '1099': 'CONTRACT_1099',
  C2C: 'C2C',
  FTE: 'FTE',
};

const EMPLOYMENT_TYPE_FROM_PRISMA: Record<'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE', TalentEmploymentTypeValue> = {
  W2: 'W2',
  CONTRACT_1099: '1099',
  C2C: 'C2C',
  FTE: 'FTE',
};

// TI-1F-B — thrown INSIDE the promotion transaction when the draft is no longer
// READY_FOR_REVIEW (a concurrent/duplicate confirm), forcing an all-or-none
// rollback. The controller maps it to a 409 (already-decided / not reviewable).
export class ResumeExtractionDraftNotReviewableError extends Error {
  constructor(public readonly draftId: string) {
    super(`ResumeExtractionDraft ${draftId} is not READY_FOR_REVIEW`);
    this.name = 'ResumeExtractionDraftNotReviewableError';
  }
}

// ============================================================================
// Durable Async Talent Intake — row/input types for the thin parent aggregate
// (TalentIntakeDraft) and its transactional outbox (TalentIntakeOutboxEvent).
// The parent owns durable workflow + review + recovery state; the governed
// ResumeExtractionDraft remains the extraction-result child.
// ============================================================================

export type TalentIntakeProcessingStatusValue =
  | 'UPLOADED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'READY'
  | 'PARTIAL'
  | 'FAILED';

export type TalentIntakeReviewStatusValue =
  | 'NOT_STARTED'
  | 'IN_REVIEW'
  | 'READY_TO_PROMOTE'
  | 'PROMOTED'
  | 'ABANDONED';

export interface TalentIntakeDraftRow {
  id: string;
  tenant_id: string;
  created_by: string;
  source_type: string;
  source_ref: string | null;
  source_event_id: string | null;
  source_filename: string | null;
  storage_key: string | null;
  artifact_sha256: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  processing_status: TalentIntakeProcessingStatusValue;
  review_status: TalentIntakeReviewStatusValue;
  structured_payload: unknown;
  review_payload: unknown;
  warning_code: string | null;
  failure_code: string | null;
  failure_detail: string | null;
  extraction_provider: string | null;
  extraction_model: string | null;
  extraction_contract_version: string | null;
  resume_extraction_draft_id: string | null;
  promoted_talent_record_id: string | null;
  promoted_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  processing_started_at: Date | null;
  processing_completed_at: Date | null;
  last_opened_at: Date | null;
}

export interface CreateTalentIntakeDraftInput {
  id: string;
  tenant_id: string;
  created_by: string;
  source_type: string;
  // Artifact metadata — OPTIONAL (null for non-upload sources).
  source_filename?: string | null;
  storage_key?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  // Source identity (ADR-0033 Decision 5) — present for non-upload producers.
  source_ref?: string | null;
  source_event_id?: string | null;
}

// Non-upload (source-agnostic) admission: idempotently create-or-recover the
// durable intake aggregate from producer identity, with no artifact, and emit
// the canonical intake event on first creation only.
export interface CreateSourceIntakeWithOutboxInput {
  id: string;
  tenant_id: string;
  created_by: string;
  source_type: string;
  source_event_id: string;
  source_ref?: string | null;
  // Optional artifact for sources that happen to carry one (e.g. a job-board
  // résumé). Absent → a pure structured-source intake, no object storage.
  storage_key?: string | null;
  source_filename?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
  // Optional structured source payload/evidence supplied by the producer.
  structured_payload?: unknown;
  // Canonical envelope fields for the emitted outbox event.
  event_type: string;
  event_version: string;
  source: string;
  subject_type: string;
  correlation_id: string;
  event_payload: unknown;
}

export interface TalentIntakeOutboxEventRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
  published_at: Date | null;
}

// A leased outbox row in the canonical envelope shape (ADR-0033). Structurally
// compatible with @aramo/events CanonicalOutboxRow; the apps/api composition
// root binds this repo to the LeaseSafeOutboxRepository port without a direct
// talent-evidence → events nx edge.
export interface TalentIntakeOutboxClaimRow {
  id: string;
  tenant_id: string;
  event_type: string;
  event_payload: unknown;
  created_at: Date;
  event_version: string | null;
  source: string | null;
  subject_type: string | null;
  subject_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  // PERSISTED post-claim attempt count — the drain's deterministic
  // retry-vs-quarantine signal (never process memory).
  publish_attempts: number;
}

@Injectable()
export class TalentEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---- TalentSkillEvidence -------------------------------------------

  async createTalentSkillEvidence(
    input: CreateTalentSkillEvidenceInput,
  ): Promise<TalentSkillEvidenceRow> {
    const created = await this.prisma.talentSkillEvidence.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_id: input.skill_id,
        source_record_id: input.source_record_id,
        surface_form: input.surface_form,
        source: input.source,
        evidence_text: input.evidence_text,
        proficiency_claim: input.proficiency_claim,
        years_claimed: input.years_claimed,
        confidence_score: input.confidence_score,
        source_document_id: input.source_document_id,
        source_refs: input.source_refs ?? [],
        source_map_version: input.source_map_version,
        resume_text_hash: input.resume_text_hash,
        work_experience_id: input.work_experience_id,
        version: input.version,
        usage_start: input.usage_start,
        usage_end: input.usage_end,
        usage_period_basis: input.usage_period_basis,
        activity_context: input.activity_context,
        created_at: input.created_at,
      },
    });
    return created as TalentSkillEvidenceRow;
  }

  async findTalentSkillEvidenceById(id: string): Promise<TalentSkillEvidenceRow | null> {
    const row = await this.prisma.talentSkillEvidence.findUnique({ where: { id } });
    return (row as TalentSkillEvidenceRow | null) ?? null;
  }

  // Gate-1 G1-B — by-talent list read for the deterministic matching-analysis
  // derivation. Tenant-scoped; MINIMAL select (surface_form for the name↔skill
  // overlap, source to detect ingested evidence, skill_id for grouping) — never
  // widen it. The derivation counts declared rows per Golden-Profile critical
  // skill (evidence_count) and checks for any source='ingested' row
  // (has_ingested_evidence).
  async findTalentSkillEvidenceByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      surface_form: string;
      source: TalentSkillEvidenceSourceValue;
      skill_id: string;
    }>
  > {
    return this.prisma.talentSkillEvidence.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: { surface_form: true, source: true, skill_id: true },
    });
  }

  // Talent-detail work-history read (LOCKED scope expansion): the declared
  // work-history rows for a talent, most-recent first (ongoing roles — null
  // end_date — sort first under DESC/NULLS-FIRST). Display projection only.
  async findWorkHistoryByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      employer_name: string;
      role_title: string;
      start_date: Date | null;
      end_date: Date | null;
      employment_type: string | null;
      description_text: string | null;
      source: TalentWorkHistorySourceValue;
    }>
  > {
    return this.prisma.talentWorkHistoryEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: {
        id: true,
        employer_name: true,
        role_title: true,
        start_date: true,
        end_date: true,
        employment_type: true,
        description_text: true,
        source: true,
      },
      orderBy: [{ end_date: 'desc' }, { start_date: 'desc' }],
    });
  }

  // Enterprise Search GS-2A — authoritative work-history rows for the Talent SEMANTIC-SOURCE
  // projection (P3). Returns ONLY authoritative entries (is_authoritative = true) and ONLY the
  // fields the compact recruiting-facts projection admits: role_title, employer_name, the DISTILLED
  // experience_summary (sanitized downstream), the free-text location (coarse-normalized downstream),
  // + start_date/id for deterministic ordering. It deliberately does NOT select description_text —
  // raw resume-derived free text is excluded from the semantic source with no fallback (P3 ruling).
  async findAuthoritativeWorkHistoryForEmbedding(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      role_title: string;
      employer_name: string;
      experience_summary: string | null;
      location: string | null;
      start_date: Date | null;
    }>
  > {
    return this.prisma.talentWorkHistoryEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id, is_authoritative: true },
      select: {
        id: true,
        role_title: true,
        employer_name: true,
        experience_summary: true,
        location: true,
        start_date: true,
      },
      orderBy: [{ start_date: 'desc' }, { id: 'asc' }],
    });
  }

  // Gate-1 G1-B — exists/count guard for the examine endpoint's LAZY extraction
  // (run extraction only when the talent has NO declared skill evidence). The
  // idempotency guard is this exists-check, NOT an upsert: re-running extraction
  // would insert duplicate rows (no @@unique on TalentSkillEvidence).
  async countTalentSkillEvidenceByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<number> {
    return this.prisma.talentSkillEvidence.count({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
    });
  }

  // ---- SKILL-TAX-1G canonical reconciliation (persistence only) ----------
  // These read the durable raw evidence (surface_form + explicit version) and
  // write the additive canonical columns. The legacy skill_id is never touched.

  async listSkillEvidenceForCanonicalization(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<Array<{ id: string; surface_form: string; version: string | null }>> {
    return this.prisma.talentSkillEvidence.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: { id: true, surface_form: true, version: true },
      orderBy: { id: 'asc' },
    });
  }

  async updateSkillEvidenceCanonical(
    id: string,
    fields: {
      canonical_skill_id: string | null;
      canonical_version_id: string | null;
      canonicalization_status: string | null;
      canonicalization_method: string | null;
      canonicalized_at: Date;
    },
  ): Promise<void> {
    await this.prisma.talentSkillEvidence.update({
      where: { id },
      data: {
        canonical_skill_id: fields.canonical_skill_id,
        canonical_version_id: fields.canonical_version_id,
        canonicalization_status: fields.canonicalization_status,
        canonicalization_method: fields.canonicalization_method,
        canonicalized_at: fields.canonicalized_at,
      },
    });
  }

  // Canonical usage intervals for the interval-union projection (§19).
  async listCanonicalUsageForTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{ canonical_skill_id: string | null; usage_start: Date | null; usage_end: Date | null }>
  > {
    return this.prisma.talentSkillEvidence.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: { canonical_skill_id: true, usage_start: true, usage_end: true },
    });
  }

  // ---- TalentWorkHistoryEntry ----------------------------------------

  async createTalentWorkHistoryEntry(
    input: CreateTalentWorkHistoryEntryInput,
  ): Promise<TalentWorkHistoryEntryRow> {
    const created = await this.prisma.talentWorkHistoryEntry.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employer_name: input.employer_name,
        role_title: input.role_title,
        start_date: input.start_date,
        end_date: input.end_date,
        location: input.location,
        employment_type: input.employment_type,
        description_text: input.description_text,
        source: input.source,
        source_document_id: input.source_document_id,
        source_refs: input.source_refs ?? [],
        source_map_version: input.source_map_version,
        resume_text_hash: input.resume_text_hash,
        company_id: input.company_id,
        experience_summary: input.experience_summary,
        is_authoritative: input.is_authoritative,
        created_at: input.created_at,
      },
    });
    return created as TalentWorkHistoryEntryRow;
  }

  async findTalentWorkHistoryEntryById(id: string): Promise<TalentWorkHistoryEntryRow | null> {
    const row = await this.prisma.talentWorkHistoryEntry.findUnique({ where: { id } });
    return (row as TalentWorkHistoryEntryRow | null) ?? null;
  }

  // Recruiter-declared work-history EDIT (LOCKED scope expansion — the Add-Talent
  // full-profile edit). REPLACE-SET semantics: the reviewed set BECOMES the
  // talent's declared ('resume'-sourced) work-history — the prior resume-sourced
  // rows are removed and the submitted set recreated, ATOMICALLY (one
  // transaction, so a mid-write failure rolls the delete back — never a half
  // state). Scoped to source='resume' so it NEVER touches rows from other source
  // channels. This is the ONE sanctioned MUTATION on the otherwise create+find
  // work-history surface — enumerated in the repository-surface spec as a
  // conscious addition ('replace' is deliberately not a forbidden prefix there,
  // unlike update/delete, because it is a bounded whole-set swap, not an
  // arbitrary column mutation). Returns the created row ids (in submit order).
  async replaceWorkHistoryForTalent(input: {
    tenant_id: string;
    talent_id: string;
    entries: readonly CreateTalentWorkHistoryEntryInput[];
  }): Promise<string[]> {
    return this.prisma.$transaction(async (tx) => {
      await tx.talentWorkHistoryEntry.deleteMany({
        where: {
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          source: 'resume',
        },
      });
      const ids: string[] = [];
      for (const e of input.entries) {
        await tx.talentWorkHistoryEntry.create({
          data: {
            id: e.id,
            talent_id: e.talent_id,
            tenant_id: e.tenant_id,
            employer_name: e.employer_name,
            role_title: e.role_title,
            start_date: e.start_date,
            end_date: e.end_date,
            location: e.location,
            employment_type: e.employment_type,
            description_text: e.description_text,
            source: e.source,
            source_document_id: e.source_document_id,
            source_refs: e.source_refs ?? [],
            source_map_version: e.source_map_version,
            resume_text_hash: e.resume_text_hash,
            company_id: e.company_id,
            experience_summary: e.experience_summary,
            is_authoritative: e.is_authoritative,
            created_at: e.created_at,
          },
        });
        ids.push(e.id);
      }
      return ids;
    });
  }

  // ---- TR-7 B1 — education + certification typed rows (the WorkHistory precedent) --

  async createTalentEducationEntry(
    input: CreateTalentEducationEntryInput,
  ): Promise<TalentEducationEntryRow> {
    const created = await this.prisma.talentEducationEntry.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        institution_name: input.institution_name,
        degree_name: input.degree_name,
        field_of_study: input.field_of_study,
        conferred_date: input.conferred_date,
        evidence_text: input.evidence_text,
        source: input.source,
        source_document_id: input.source_document_id,
        source_refs: input.source_refs ?? [],
        source_map_version: input.source_map_version,
        resume_text_hash: input.resume_text_hash,
        created_at: input.created_at,
      },
    });
    return created as TalentEducationEntryRow;
  }

  async findTalentEducationEntryById(id: string): Promise<TalentEducationEntryRow | null> {
    const row = await this.prisma.talentEducationEntry.findUnique({ where: { id } });
    return (row as TalentEducationEntryRow | null) ?? null;
  }

  async createTalentCertificationEntry(
    input: CreateTalentCertificationEntryInput,
  ): Promise<TalentCertificationEntryRow> {
    const created = await this.prisma.talentCertificationEntry.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        certification_name: input.certification_name,
        issuer_name: input.issuer_name,
        credential_ref: input.credential_ref,
        issued_date: input.issued_date,
        expiry_date: input.expiry_date,
        evidence_text: input.evidence_text,
        source: input.source,
        source_document_id: input.source_document_id,
        source_refs: input.source_refs ?? [],
        source_map_version: input.source_map_version,
        resume_text_hash: input.resume_text_hash,
        created_at: input.created_at,
      },
    });
    return created as TalentCertificationEntryRow;
  }

  async findTalentCertificationEntryById(id: string): Promise<TalentCertificationEntryRow | null> {
    const row = await this.prisma.talentCertificationEntry.findUnique({ where: { id } });
    return (row as TalentCertificationEntryRow | null) ?? null;
  }

  // ---- HF2 R6 — TalentProjectExperience (child of a WorkExperience) --------

  async createTalentProjectExperience(
    input: CreateTalentProjectExperienceInput,
  ): Promise<TalentProjectExperienceRow> {
    const created = await this.prisma.talentProjectExperience.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_experience_id: input.work_experience_id,
        project_name: input.project_name,
        context_summary: input.context_summary,
        domain: input.domain,
        start_date: input.start_date,
        end_date: input.end_date,
        source_document_id: input.source_document_id,
        source_refs: input.source_refs ?? [],
        source_map_version: input.source_map_version,
        resume_text_hash: input.resume_text_hash,
        created_at: input.created_at,
      },
    });
    return created as TalentProjectExperienceRow;
  }

  async findTalentProjectExperienceById(id: string): Promise<TalentProjectExperienceRow | null> {
    const row = await this.prisma.talentProjectExperience.findUnique({ where: { id } });
    return (row as TalentProjectExperienceRow | null) ?? null;
  }

  // By-talent project read (display projection). Tenant-scoped.
  async findProjectExperienceByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentProjectExperienceRow[]> {
    const rows = await this.prisma.talentProjectExperience.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      orderBy: [{ end_date: 'desc' }, { start_date: 'desc' }],
    });
    return rows as TalentProjectExperienceRow[];
  }

  // ---- TR-4 B2 ledger-routing reads (the dual-write + backfill source) --------
  // Distinct from findTalentSkillEvidenceByTalent (the matching-derivation read,
  // deliberately minimal): these carry the row `id` (→ the ledger source_ref) plus
  // exactly the fields the pure canonical mapper needs. Tenant-scoped.

  async listSkillEvidenceForLedger(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<Array<{ id: string; surface_form: string; skill_id: string }>> {
    return this.prisma.talentSkillEvidence.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: { id: true, surface_form: true, skill_id: true },
      orderBy: { id: 'asc' },
    });
  }

  async listWorkHistoryForLedger(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      employer_name: string;
      role_title: string;
      start_date: Date | null;
      end_date: Date | null;
      employment_type: string | null;
    }>
  > {
    return this.prisma.talentWorkHistoryEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: {
        id: true,
        employer_name: true,
        role_title: true,
        start_date: true,
        end_date: true,
        employment_type: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  // TR-7 B1 — the education/certification ledger-routing reads (the WorkHistory
  // precedent): row `id` (→ ledger source_ref) + exactly the fields the pure DEGREE/
  // CERTIFICATION mappers need. Tenant-scoped, id-ordered (stable dual-write order).
  async listEducationForLedger(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      institution_name: string;
      degree_name: string;
      field_of_study: string | null;
      conferred_date: Date | null;
    }>
  > {
    return this.prisma.talentEducationEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: {
        id: true,
        institution_name: true,
        degree_name: true,
        field_of_study: true,
        conferred_date: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  async listCertificationForLedger(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      certification_name: string;
      issuer_name: string | null;
      credential_ref: string | null;
      issued_date: Date | null;
      expiry_date: Date | null;
    }>
  > {
    return this.prisma.talentCertificationEntry.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: {
        id: true,
        certification_name: true,
        issuer_name: true,
        credential_ref: true,
        issued_date: true,
        expiry_date: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  // TALENT-INTEL-1 (TI-1C) — the declared work-authorization ledger read. The
  // RIGHT_TO_WORK routing consumes these typed rows and writes the rows lacking a
  // ledger counterpart (idempotent, source_ref = the row id). Bounded, tenant-
  // scoped, single-purpose — the same shape as the credential reads above.
  async listWorkAuthorizationForLedger(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<
    Array<{
      id: string;
      work_authorization_status: string;
      authorized_to_work_in: string[];
      visa_type: string | null;
      requires_sponsorship: boolean;
    }>
  > {
    return this.prisma.talentWorkAuthorization.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      select: {
        id: true,
        work_authorization_status: true,
        authorized_to_work_in: true,
        visa_type: true,
        requires_sponsorship: true,
      },
      orderBy: { id: 'asc' },
    });
  }

  // TALENT-INTEL-1 TI-1G §3 — the FULL append-only work-authorization assertion
  // history for a talent (newest-asserted first), incl. the temporal columns, for
  // the read surface + deterministic current-selection. Tenant-scoped, bounded read.
  async findWorkAuthorizationByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentWorkAuthorizationRow[]> {
    const rows = await this.prisma.talentWorkAuthorization.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      orderBy: [{ asserted_at: 'desc' }, { id: 'desc' }],
    });
    return rows as TalentWorkAuthorizationRow[];
  }

  // Backfill enumeration: the distinct talent_ids that own ANY typed skill,
  // work-history, education, or certification evidence in a tenant (the union — a
  // talent may have only one kind).
  async listTalentIdsWithEvidenceByTenant(tenant_id: string): Promise<string[]> {
    const [skills, work, education, certification] = await Promise.all([
      this.prisma.talentSkillEvidence.findMany({
        where: { tenant_id },
        select: { talent_id: true },
        distinct: ['talent_id'],
      }),
      this.prisma.talentWorkHistoryEntry.findMany({
        where: { tenant_id },
        select: { talent_id: true },
        distinct: ['talent_id'],
      }),
      this.prisma.talentEducationEntry.findMany({
        where: { tenant_id },
        select: { talent_id: true },
        distinct: ['talent_id'],
      }),
      this.prisma.talentCertificationEntry.findMany({
        where: { tenant_id },
        select: { talent_id: true },
        distinct: ['talent_id'],
      }),
    ]);
    const ids = new Set<string>();
    for (const r of skills) ids.add(r.talent_id);
    for (const r of work) ids.add(r.talent_id);
    for (const r of education) ids.add(r.talent_id);
    for (const r of certification) ids.add(r.talent_id);
    return [...ids].sort();
  }

  // Backfill --all-tenants: every tenant owning any typed skill/work-history/
  // education/certification row.
  async listTenantIdsWithEvidence(): Promise<string[]> {
    const [skills, work, education, certification] = await Promise.all([
      this.prisma.talentSkillEvidence.findMany({
        select: { tenant_id: true },
        distinct: ['tenant_id'],
      }),
      this.prisma.talentWorkHistoryEntry.findMany({
        select: { tenant_id: true },
        distinct: ['tenant_id'],
      }),
      this.prisma.talentEducationEntry.findMany({
        select: { tenant_id: true },
        distinct: ['tenant_id'],
      }),
      this.prisma.talentCertificationEntry.findMany({
        select: { tenant_id: true },
        distinct: ['tenant_id'],
      }),
    ]);
    const ids = new Set<string>();
    for (const r of skills) ids.add(r.tenant_id);
    for (const r of work) ids.add(r.tenant_id);
    for (const r of education) ids.add(r.tenant_id);
    for (const r of certification) ids.add(r.tenant_id);
    return [...ids].sort();
  }

  // ---- TalentContactMethod -------------------------------------------

  async createTalentContactMethod(
    input: CreateTalentContactMethodInput,
  ): Promise<TalentContactMethodRow> {
    const created = await this.prisma.talentContactMethod.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        type: input.type,
        value: input.value,
        is_primary: input.is_primary,
        verification_status: input.verification_status,
        verified_at: input.verified_at,
        created_at: input.created_at,
      },
    });
    return created as TalentContactMethodRow;
  }

  async findTalentContactMethodById(id: string): Promise<TalentContactMethodRow | null> {
    const row = await this.prisma.talentContactMethod.findUnique({ where: { id } });
    return (row as TalentContactMethodRow | null) ?? null;
  }

  // ---- TalentRateExpectation -----------------------------------------

  async createTalentRateExpectation(
    input: CreateTalentRateExpectationInput,
  ): Promise<TalentRateExpectationRow> {
    const created = await this.prisma.talentRateExpectation.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        employment_type: EMPLOYMENT_TYPE_TO_PRISMA[input.employment_type],
        min_rate: input.min_rate,
        target_rate: input.target_rate,
        currency: input.currency,
        period: input.period,
        source: input.source,
        updated_at: input.updated_at,
      },
    });
    return {
      ...(created as Omit<TalentRateExpectationRow, 'employment_type'>),
      employment_type:
        EMPLOYMENT_TYPE_FROM_PRISMA[
          (created as { employment_type: 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE' }).employment_type
        ],
    };
  }

  async findTalentRateExpectationById(id: string): Promise<TalentRateExpectationRow | null> {
    const row = await this.prisma.talentRateExpectation.findUnique({ where: { id } });
    if (row === null) return null;
    return {
      ...(row as Omit<TalentRateExpectationRow, 'employment_type'>),
      employment_type:
        EMPLOYMENT_TYPE_FROM_PRISMA[
          (row as { employment_type: 'W2' | 'CONTRACT_1099' | 'C2C' | 'FTE' }).employment_type
        ],
    };
  }

  // ---- TalentWorkAuthorization ---------------------------------------
  // Per directive §2 Ruling 4 / §9 F16: entity ships with its §2.2 column
  // shape; the Architecture §14.4 sensitive-field PII-handling treatment
  // (encryption, access logging, elevated-permission access) is deferred
  // to follow-up F16, pending the §14.3 sensitive-field implementation
  // artifact. The repository surface here is column-only — no F16 mechanics.

  async createTalentWorkAuthorization(
    input: CreateTalentWorkAuthorizationInput,
  ): Promise<TalentWorkAuthorizationRow> {
    const created = await this.prisma.talentWorkAuthorization.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        work_authorization_status: input.work_authorization_status,
        authorized_to_work_in: [...input.authorized_to_work_in],
        visa_type: input.visa_type,
        requires_sponsorship: input.requires_sponsorship,
        updated_at: input.updated_at,
        // TI-1G §2 — asserted_at omitted → DB @default(now()); temporal dates set
        // only when explicitly supplied (never invented).
        ...(input.asserted_at !== undefined ? { asserted_at: input.asserted_at } : {}),
        effective_from: input.effective_from ?? null,
        effective_to: input.effective_to ?? null,
        expires_at: input.expires_at ?? null,
      },
    });
    return created as TalentWorkAuthorizationRow;
  }

  async findTalentWorkAuthorizationById(
    id: string,
  ): Promise<TalentWorkAuthorizationRow | null> {
    const row = await this.prisma.talentWorkAuthorization.findUnique({ where: { id } });
    return (row as TalentWorkAuthorizationRow | null) ?? null;
  }

  // ---- TalentDocument ------------------------------------------------

  // DOC-1b — the six SYSTEM DocumentType ids (seeded by the DOC-1b migration),
  // keyed by TalentDocumentType. Deterministic; must match the migration.
  private static readonly TALENT_DOCUMENT_TYPE_IDS: Record<TalentDocumentTypeValue, string> = {
    resume: '01900000-0000-7000-8000-0000000002d1',
    cover_letter: '01900000-0000-7000-8000-0000000002d2',
    certification: '01900000-0000-7000-8000-0000000002d3',
    work_sample: '01900000-0000-7000-8000-0000000002d4',
    reference_letter: '01900000-0000-7000-8000-0000000002d5',
    other: '01900000-0000-7000-8000-0000000002d6',
  };

  // DOC-1b — mint the canonical documents.Document quartet (Document +
  // DocumentRevision + DocumentArtifact + DocumentAssociation(TALENT)) for a
  // talent-uploaded document, INSIDE the caller's talent_evidence transaction.
  // Same Prisma client / same connection → atomic with the TalentDocument write;
  // a rollback removes both (NO orphan). This is the resolution of the W2
  // cross-schema-atomicity concern (supersedes the documents-first/orphan sketch
  // in directive R-1b-3). Returns the new documents.Document id.
  private async mintCanonicalDocument(
    tx: { $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> },
    input: {
      tenant_id: string;
      talent_id: string;
      document_type: TalentDocumentTypeValue;
      filename: string;
      file_storage_ref: string;
      mime_type: string;
      size_bytes: number;
      uploaded_by_actor_id: string;
      uploaded_at: Date;
      is_active: boolean;
      // Resume Revision Lifecycle §4 — the real artifact byte SHA-256, written
      // into the canonical DocumentRevision/DocumentArtifact instead of the
      // 'unknown' placeholder. Absent ⇒ legacy 'unknown' (non-resume callers).
      artifact_sha256?: string;
    },
  ): Promise<string> {
    const documentId = randomUUID();
    const revisionId = randomUUID();
    const artifactId = randomUUID();
    const associationId = randomUUID();
    const typeId = TalentEvidenceRepository.TALENT_DOCUMENT_TYPE_IDS[input.document_type];
    const status = input.is_active ? 'EXECUTED' : 'VOIDED';
    const sha256 = input.artifact_sha256 ?? 'unknown';
    await tx.$executeRawUnsafe(
      `INSERT INTO "documents"."Document" ("id","tenant_id","document_type_id","title","status","execution_mode","source_kind","created_by","created_at") VALUES ($1,$2,$3,$4,$5,'NO_SIGNATURE','UPLOADED',$6,$7)`,
      documentId, input.tenant_id, typeId, input.filename, status, input.uploaded_by_actor_id, input.uploaded_at,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "documents"."DocumentRevision" ("id","tenant_id","document_id","revision_number","mime_type","byte_size","content_sha256","status","created_by","created_at","frozen_at") VALUES ($1,$2,$3,1,$4,$5,$6,'FROZEN',$7,$8,$8)`,
      revisionId, input.tenant_id, documentId, input.mime_type, input.size_bytes, sha256, input.uploaded_by_actor_id, input.uploaded_at,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "documents"."DocumentArtifact" ("id","tenant_id","revision_id","document_id","artifact_role","storage_provider","storage_locator","mime_type","byte_size","sha256","immutability_state","retention_class","created_at","created_by") VALUES ($1,$2,$3,$4,'SOURCE_UPLOAD','aramo-s3',$5,$6,$7,$8,'FROZEN','TALENT_DOCUMENT',$9,$10)`,
      artifactId, input.tenant_id, revisionId, documentId, input.file_storage_ref, input.mime_type, input.size_bytes, sha256, input.uploaded_at, input.uploaded_by_actor_id,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO "documents"."DocumentAssociation" ("id","tenant_id","document_id","resource_type","resource_id","relationship","created_at","created_by") VALUES ($1,$2,$3,'TALENT',$4,'SUBJECT',$5,$6)`,
      associationId, input.tenant_id, documentId, input.talent_id, input.uploaded_at, input.uploaded_by_actor_id,
    );
    return documentId;
  }

  async createTalentDocument(
    input: CreateTalentDocumentInput,
  ): Promise<TalentDocumentRow> {
    return this.prisma.$transaction(async (tx) => {
      const documentId = await this.mintCanonicalDocument(tx, {
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        document_type: input.document_type,
        filename: input.filename,
        file_storage_ref: input.file_storage_ref,
        mime_type: input.mime_type,
        size_bytes: input.size_bytes,
        uploaded_by_actor_id: input.uploaded_by_actor_id,
        uploaded_at: input.uploaded_at,
        is_active: input.is_active,
        artifact_sha256: input.artifact_sha256,
      });
      const created = await tx.talentDocument.create({
        data: {
          id: input.id,
          talent_id: input.talent_id,
          tenant_id: input.tenant_id,
          parse_status: input.parse_status,
          consent_scope_at_upload: [...input.consent_scope_at_upload],
          retention_policy: input.retention_policy,
          is_active: input.is_active,
          document_id: documentId,
        },
      });
      return created as TalentDocumentRow;
    });
  }

  async findTalentDocumentById(id: string): Promise<TalentDocumentRow | null> {
    const row = await this.prisma.talentDocument.findUnique({ where: { id } });
    return (row as TalentDocumentRow | null) ?? null;
  }

  // ---- TalentResumeEdition / TalentResumeDefault (TALENT-INTEL-1 §5) --------

  async createTalentResumeEdition(
    input: CreateTalentResumeEditionInput,
  ): Promise<TalentResumeEditionRow> {
    const created = await this.prisma.talentResumeEdition.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        talent_document_id: input.talent_document_id,
        content_hash: input.content_hash,
        artifact_sha256: input.artifact_sha256,
        created_at: input.created_at,
        created_by: input.created_by,
        attachment_id: input.attachment_id,
        purpose: input.purpose,
        label: input.label,
        requisition_id: input.requisition_id,
        client_context_id: input.client_context_id,
        derived_from_edition_id: input.derived_from_edition_id,
        lifecycle_status: input.lifecycle_status,
      },
    });
    return created as TalentResumeEditionRow;
  }

  async findTalentResumeEditionById(
    id: string,
  ): Promise<TalentResumeEditionRow | null> {
    const row = await this.prisma.talentResumeEdition.findUnique({ where: { id } });
    return (row as TalentResumeEditionRow | null) ?? null;
  }

  // All editions for a Talent, newest-first. Multiple editions may be
  // simultaneously valid (ruling 2) — this returns them ALL, ordered by upload;
  // it never treats the newest as the sole truth.
  async findResumeEditionsByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentResumeEditionRow[]> {
    const rows = await this.prisma.talentResumeEdition.findMany({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      orderBy: { created_at: 'desc' },
    });
    return rows as TalentResumeEditionRow[];
  }

  // Set (or move) the Talent's default/presentation resume — SEPARATE from
  // evidence validity (rulings 2/10). Idempotent per (tenant_id, talent_id):
  // the upsert enforces exactly one default per Talent and never touches any
  // edition's lifecycle or the evidence it grounded.
  async setDefaultResumeEdition(
    input: SetTalentResumeDefaultInput,
  ): Promise<TalentResumeDefaultRow> {
    const row = await this.prisma.talentResumeDefault.upsert({
      where: {
        tenant_id_talent_id: {
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
        },
      },
      create: {
        id: input.id,
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        resume_edition_id: input.resume_edition_id,
        set_at: input.set_at,
        set_by: input.set_by,
      },
      update: {
        resume_edition_id: input.resume_edition_id,
        set_at: input.set_at,
        set_by: input.set_by,
      },
    });
    return row as TalentResumeDefaultRow;
  }

  async findDefaultResumeEdition(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentResumeDefaultRow | null> {
    const row = await this.prisma.talentResumeDefault.findUnique({
      where: {
        tenant_id_talent_id: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      },
    });
    return (row as TalentResumeDefaultRow | null) ?? null;
  }

  // TALENT-INTEL-1 (TI-1F-A) — persist/enqueue the governed-extraction REVIEW
  // draft, IDEMPOTENT on the durable source identity (tenant_id, source_kind,
  // source_ref): a retry of the SAME source returns the existing draft untouched
  // (never a duplicate). The draft is NOT Talent evidence and NOT authoritative.
  async upsertResumeExtractionDraft(
    input: UpsertResumeExtractionDraftInput,
  ): Promise<ResumeExtractionDraftRow> {
    const row = await this.prisma.resumeExtractionDraft.upsert({
      where: {
        tenant_id_source_kind_source_ref: {
          tenant_id: input.tenant_id,
          source_kind: input.source_kind,
          source_ref: input.source_ref,
        },
      },
      create: {
        id: input.id,
        tenant_id: input.tenant_id,
        source_kind: input.source_kind,
        source_ref: input.source_ref,
        talent_id: input.talent_id ?? null,
        talent_document_id: input.talent_document_id ?? null,
        resume_edition_id: input.resume_edition_id ?? null,
        status: input.status,
        structured_payload: (input.structured_payload ?? undefined) as never,
        source_map_version: input.source_map_version ?? null,
        resume_text_hash: input.resume_text_hash ?? null,
        extractor_version: input.extractor_version ?? null,
        created_at: input.created_at,
        created_by: input.created_by,
      },
      // Idempotent — a retry of the same source keeps the existing draft as-is.
      update: {},
    });
    return row as unknown as ResumeExtractionDraftRow;
  }

  async findResumeExtractionDraftBySource(args: {
    tenant_id: string;
    source_kind: ResumeExtractionDraftSourceKindValue;
    source_ref: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    const row = await this.prisma.resumeExtractionDraft.findUnique({
      where: {
        tenant_id_source_kind_source_ref: {
          tenant_id: args.tenant_id,
          source_kind: args.source_kind,
          source_ref: args.source_ref,
        },
      },
    });
    return (row as unknown as ResumeExtractionDraftRow | null) ?? null;
  }

  // Worker poll — the PROCESSING drafts awaiting governed extraction, oldest first.
  async findProcessingResumeExtractionDrafts(args: {
    limit: number;
  }): Promise<ResumeExtractionDraftRow[]> {
    const rows = await this.prisma.resumeExtractionDraft.findMany({
      where: { status: 'PROCESSING' },
      orderBy: { created_at: 'asc' },
      take: args.limit,
    });
    return rows as unknown as ResumeExtractionDraftRow[];
  }

  // Worker success — the grounded governed output lands on the draft and it
  // flips to READY_FOR_REVIEW. NO typed evidence is written (that is TI-1F-B).
  async markResumeExtractionDraftReadyForReview(input: {
    id: string;
    structured_payload: unknown;
    extractor_version?: string | null;
    source_map_version?: string | null;
    resume_text_hash?: string | null;
  }): Promise<void> {
    await this.prisma.resumeExtractionDraft.update({
      where: { id: input.id },
      data: {
        status: 'READY_FOR_REVIEW',
        structured_payload: input.structured_payload as never,
        extractor_version: input.extractor_version ?? null,
        source_map_version: input.source_map_version ?? null,
        resume_text_hash: input.resume_text_hash ?? null,
      },
    });
  }

  // Worker failure — bump the attempt counter + record the internal error code
  // (never projected onto the recruiter contract). Status → FAILED.
  async markResumeExtractionDraftFailed(input: {
    id: string;
    last_error_code: string;
    last_error_at: Date;
  }): Promise<void> {
    await this.prisma.resumeExtractionDraft.update({
      where: { id: input.id },
      data: {
        status: 'FAILED',
        attempt_count: { increment: 1 },
        last_error_code: input.last_error_code,
        last_error_at: input.last_error_at,
      },
    });
  }

  // TI-1F-B — the review-context lookup for an EXISTING-Talent confirm: the
  // ATTACHMENT draft bound to the edition under review. Tenant-scoped; the
  // controller has already proven the edition belongs to the talent+tenant.
  async findResumeExtractionDraftByEdition(args: {
    tenant_id: string;
    resume_edition_id: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    const row = await this.prisma.resumeExtractionDraft.findFirst({
      where: { tenant_id: args.tenant_id, resume_edition_id: args.resume_edition_id },
    });
    return (row as unknown as ResumeExtractionDraftRow | null) ?? null;
  }

  // TI-1F-B — the CREATE_DRAFT_UPLOAD close-out: when a confirmed create supplies
  // its originating draft, the draft is linked to the just-created Talent identity
  // and marked ACCEPTED. Guarded on READY_FOR_REVIEW so a PROCESSING/FAILED/already
  // -decided draft is never silently re-accepted; returns the rows affected so the
  // caller can treat a 0-count as a no-op (best-effort on the create path).
  async markResumeExtractionDraftAccepted(input: {
    id: string;
    tenant_id: string;
    talent_id?: string | null;
    talent_document_id?: string | null;
    resume_edition_id?: string | null;
    reviewed_by: string;
    reviewed_at: Date;
  }): Promise<number> {
    const updated = await this.prisma.resumeExtractionDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id, status: 'READY_FOR_REVIEW' },
      data: {
        status: 'ACCEPTED',
        ...(input.talent_id != null ? { talent_id: input.talent_id } : {}),
        ...(input.talent_document_id != null ? { talent_document_id: input.talent_document_id } : {}),
        ...(input.resume_edition_id != null ? { resume_edition_id: input.resume_edition_id } : {}),
        reviewed_by: input.reviewed_by,
        reviewed_at: input.reviewed_at,
      },
    });
    return updated.count;
  }

  // TI-1F-B — REJECT: the recruiter declines the draft. No typed evidence, no
  // reconciliation (§3). Retained as governed review/audit history. Guarded on
  // READY_FOR_REVIEW; returns rows affected (0 = not reviewable → caller 409s).
  async markResumeExtractionDraftRejected(input: {
    id: string;
    tenant_id: string;
    reviewed_by: string;
    reviewed_at: Date;
  }): Promise<number> {
    const updated = await this.prisma.resumeExtractionDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id, status: 'READY_FOR_REVIEW' },
      data: { status: 'REJECTED', reviewed_by: input.reviewed_by, reviewed_at: input.reviewed_at },
    });
    return updated.count;
  }

  // ==========================================================================
  // Durable Async Talent Intake — the thin parent aggregate (TalentIntakeDraft)
  // + its transactional outbox. All reads/writes are tenant-scoped. Concurrency
  // is guarded with an optimistic `version` CAS. The DB commit is the durable
  // handoff boundary and never depends on Redis.
  // ==========================================================================

  // Create intake: a durable pre-Talent draft in UPLOADED state. The object key
  // is already minted; the binary is uploaded directly by the browser next.
  async createTalentIntakeDraft(
    input: CreateTalentIntakeDraftInput,
  ): Promise<TalentIntakeDraftRow> {
    const row = await this.prisma.talentIntakeDraft.create({
      data: {
        id: input.id,
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        source_type: input.source_type,
        source_ref: input.source_ref ?? null,
        source_event_id: input.source_event_id ?? null,
        source_filename: input.source_filename ?? null,
        storage_key: input.storage_key ?? null,
        mime_type: input.mime_type ?? null,
        size_bytes: input.size_bytes ?? null,
        processing_status: 'UPLOADED',
        review_status: 'NOT_STARTED',
      },
    });
    return row as unknown as TalentIntakeDraftRow;
  }

  // Source-agnostic admission (ADR-0033 Decision 5). ONE transaction:
  // idempotently insert the aggregate keyed on (tenant_id, source_type,
  // source_event_id) via the partial unique index, and emit the canonical
  // outbox event ONLY on a fresh insert. A producer that redelivers the same
  // source_event_id (job-board retry, sourcing redelivery) converges on the
  // SAME TalentIntakeDraft and enqueues nothing the second time — the
  // invariant: same tenant + source_type + source_event_id → one intake. No
  // fake storage_key is required; the artifact is optional.
  async createOrRecoverSourceIntakeWithOutbox(
    input: CreateSourceIntakeWithOutboxInput,
  ): Promise<{ created: boolean; draft: TalentIntakeDraftRow }> {
    return this.prisma.$transaction(async (tx) => {
      // Idempotent insert. ON CONFLICT targets the partial unique index
      // predicate (source_event_id IS NOT NULL); a conflict returns no row.
      const inserted = await tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "talent_evidence"."TalentIntakeDraft"
          ("id", "tenant_id", "created_by", "source_type", "source_ref",
           "source_event_id", "source_filename", "storage_key", "mime_type",
           "size_bytes", "structured_payload", "processing_status",
           "review_status", "version", "created_at", "updated_at")
        VALUES
          (${input.id}::uuid, ${input.tenant_id}::uuid, ${input.created_by}::uuid,
           ${input.source_type}, ${input.source_ref ?? null},
           ${input.source_event_id}, ${input.source_filename ?? null},
           ${input.storage_key ?? null}, ${input.mime_type ?? null},
           ${input.size_bytes ?? null},
           ${input.structured_payload === undefined ? null : JSON.stringify(input.structured_payload)}::jsonb,
           'QUEUED', 'NOT_STARTED', 0, now(), now())
        ON CONFLICT ("tenant_id", "source_type", "source_event_id")
          WHERE "source_event_id" IS NOT NULL
        DO NOTHING
        RETURNING "id"
      `;
      const created = inserted.length === 1;
      if (created) {
        await tx.talentIntakeOutboxEvent.create({
          data: {
            tenant_id: input.tenant_id,
            event_type: input.event_type,
            event_payload: input.event_payload as never,
            event_version: input.event_version,
            source: input.source,
            subject_type: input.subject_type,
            subject_id: input.id,
            correlation_id: input.correlation_id,
          },
        });
      }
      const draft = await tx.talentIntakeDraft.findFirst({
        where: {
          tenant_id: input.tenant_id,
          source_type: input.source_type,
          source_event_id: input.source_event_id,
        },
      });
      if (draft === null) {
        // Unreachable: either the insert created it or a prior row conflicted.
        throw new Error('talent_intake_source_admission_row_missing');
      }
      return { created, draft: draft as unknown as TalentIntakeDraftRow };
    });
  }

  async findTalentIntakeDraftById(args: {
    tenant_id: string;
    id: string;
  }): Promise<TalentIntakeDraftRow | null> {
    const row = await this.prisma.talentIntakeDraft.findFirst({
      where: { id: args.id, tenant_id: args.tenant_id },
    });
    return (row as unknown as TalentIntakeDraftRow | null) ?? null;
  }

  // Recovery surface — a recruiter's resumable drafts, newest first. Promoted
  // drafts normally leave the active list.
  async listTalentIntakeDraftsForCreator(input: {
    tenant_id: string;
    created_by: string;
    limit: number;
    includePromoted?: boolean;
  }): Promise<TalentIntakeDraftRow[]> {
    const rows = await this.prisma.talentIntakeDraft.findMany({
      where: {
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        ...(input.includePromoted === true ? {} : { review_status: { not: 'PROMOTED' } }),
      },
      orderBy: { created_at: 'desc' },
      take: input.limit,
    });
    return rows as unknown as TalentIntakeDraftRow[];
  }

  // complete-upload: ONE DB transaction — flip UPLOADED → QUEUED and write the
  // outbox event atomically (the durable handoff). Guarded on UPLOADED so a
  // replay (already QUEUED/PROCESSING/…) is an idempotent no-op that enqueues
  // nothing and returns the existing draft.
  async completeUploadWithOutbox(input: {
    tenant_id: string;
    id: string;
    artifact_sha256?: string | null;
    mime_type?: string | null;
    size_bytes?: number | null;
    event_type: string;
    event_payload: unknown;
  }): Promise<{ enqueued: boolean; draft: TalentIntakeDraftRow | null }> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.talentIntakeDraft.updateMany({
        where: { id: input.id, tenant_id: input.tenant_id, processing_status: 'UPLOADED' },
        data: {
          processing_status: 'QUEUED',
          artifact_sha256: input.artifact_sha256 ?? undefined,
          mime_type: input.mime_type ?? undefined,
          size_bytes: input.size_bytes ?? undefined,
          version: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        await tx.talentIntakeOutboxEvent.create({
          data: {
            tenant_id: input.tenant_id,
            event_type: input.event_type,
            event_payload: input.event_payload as never,
          },
        });
      }
      const draft = await tx.talentIntakeDraft.findFirst({
        where: { id: input.id, tenant_id: input.tenant_id },
      });
      return {
        enqueued: updated.count === 1,
        draft: (draft as unknown as TalentIntakeDraftRow | null) ?? null,
      };
    });
  }

  // retry: re-queue a FAILED/PARTIAL draft against the SAME stored artifact and
  // re-emit the outbox event, in one transaction. No re-upload. Clears prior
  // failure/warning surfacing. Guarded so an in-flight (QUEUED/PROCESSING) or
  // PROMOTED draft is never re-queued.
  async requeueTalentIntakeDraftWithOutbox(input: {
    tenant_id: string;
    id: string;
    event_type: string;
    event_payload: unknown;
  }): Promise<{ enqueued: boolean; draft: TalentIntakeDraftRow | null }> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.talentIntakeDraft.updateMany({
        where: {
          id: input.id,
          tenant_id: input.tenant_id,
          processing_status: { in: ['FAILED', 'PARTIAL'] },
          promoted_talent_record_id: null,
        },
        data: {
          processing_status: 'QUEUED',
          failure_code: null,
          failure_detail: null,
          warning_code: null,
          processing_started_at: null,
          processing_completed_at: null,
          version: { increment: 1 },
        },
      });
      if (updated.count === 1) {
        await tx.talentIntakeOutboxEvent.create({
          data: {
            tenant_id: input.tenant_id,
            event_type: input.event_type,
            event_payload: input.event_payload as never,
          },
        });
      }
      const draft = await tx.talentIntakeDraft.findFirst({
        where: { id: input.id, tenant_id: input.tenant_id },
      });
      return {
        enqueued: updated.count === 1,
        draft: (draft as unknown as TalentIntakeDraftRow | null) ?? null,
      };
    });
  }

  // Worker CAS claim: QUEUED → PROCESSING guarded on the exact version, so
  // at-least-once queue delivery / duplicate ticks produce exactly one claimer
  // (count === 1). A non-claimer gets 0 and skips.
  async claimTalentIntakeDraftForProcessing(input: {
    tenant_id: string;
    id: string;
    expected_version: number;
  }): Promise<number> {
    const updated = await this.prisma.talentIntakeDraft.updateMany({
      where: {
        id: input.id,
        tenant_id: input.tenant_id,
        version: input.expected_version,
        processing_status: 'QUEUED',
      },
      data: {
        processing_status: 'PROCESSING',
        processing_started_at: new Date(),
        version: { increment: 1 },
      },
    });
    return updated.count;
  }

  // Safety-net drain — QUEUED drafts the relay may not have enqueued (Redis down
  // at commit time, relay lag). Oldest first.
  async findQueuedTalentIntakeDrafts(args: {
    limit: number;
  }): Promise<TalentIntakeDraftRow[]> {
    const rows = await this.prisma.talentIntakeDraft.findMany({
      where: { processing_status: 'QUEUED' },
      orderBy: { created_at: 'asc' },
      take: args.limit,
    });
    return rows as unknown as TalentIntakeDraftRow[];
  }

  // Worker result — persist the governed extraction outcome and advance the
  // processing dimension to a terminal state. The merged review_payload (edits
  // preserved) is computed by the worker and passed verbatim.
  async markTalentIntakeDraftProcessed(input: {
    tenant_id: string;
    id: string;
    processing_status: 'READY' | 'PARTIAL' | 'FAILED';
    structured_payload?: unknown;
    review_payload?: unknown;
    warning_code?: string | null;
    failure_code?: string | null;
    failure_detail?: string | null;
    extraction_provider?: string | null;
    extraction_model?: string | null;
    extraction_contract_version?: string | null;
    resume_extraction_draft_id?: string | null;
    processing_completed_at: Date;
  }): Promise<void> {
    await this.prisma.talentIntakeDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id },
      data: {
        processing_status: input.processing_status,
        ...(input.structured_payload !== undefined
          ? { structured_payload: input.structured_payload as never }
          : {}),
        ...(input.review_payload !== undefined
          ? { review_payload: input.review_payload as never }
          : {}),
        warning_code: input.warning_code ?? undefined,
        failure_code: input.failure_code ?? undefined,
        failure_detail: input.failure_detail ?? undefined,
        extraction_provider: input.extraction_provider ?? undefined,
        extraction_model: input.extraction_model ?? undefined,
        extraction_contract_version: input.extraction_contract_version ?? undefined,
        resume_extraction_draft_id: input.resume_extraction_draft_id ?? undefined,
        processing_completed_at: input.processing_completed_at,
        version: { increment: 1 },
      },
    });
  }

  // Persisted recruiter review — CAS on the exact version so a stale save (older
  // tab / device) returns 0 and the caller can 409. review_status advances to
  // IN_REVIEW on the first save unless the caller overrides.
  async saveTalentIntakeDraftReview(input: {
    tenant_id: string;
    id: string;
    expected_version: number;
    review_payload: unknown;
    review_status?: TalentIntakeReviewStatusValue;
  }): Promise<number> {
    const updated = await this.prisma.talentIntakeDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id, version: input.expected_version },
      data: {
        review_payload: input.review_payload as never,
        ...(input.review_status !== undefined ? { review_status: input.review_status } : {}),
        version: { increment: 1 },
      },
    });
    return updated.count;
  }

  // Promotion linkage — set ONCE, guarded on promoted_talent_record_id IS NULL,
  // so a racing/duplicate promote gets count 0 and resolves to the existing
  // TalentRecord (idempotency). Distinct column — never the overloaded child
  // ResumeExtractionDraft.talent_id.
  async markTalentIntakeDraftPromoted(input: {
    tenant_id: string;
    id: string;
    promoted_talent_record_id: string;
    promoted_at: Date;
  }): Promise<number> {
    const updated = await this.prisma.talentIntakeDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id, promoted_talent_record_id: null },
      data: {
        review_status: 'PROMOTED',
        promoted_talent_record_id: input.promoted_talent_record_id,
        promoted_at: input.promoted_at,
        version: { increment: 1 },
      },
    });
    return updated.count;
  }

  async touchTalentIntakeDraftOpened(input: {
    tenant_id: string;
    id: string;
  }): Promise<void> {
    await this.prisma.talentIntakeDraft.updateMany({
      where: { id: input.id, tenant_id: input.tenant_id },
      data: { last_opened_at: new Date() },
    });
  }

  // Intake outbox drain (read side for the relay).
  async findUnpublishedTalentIntakeOutboxEvents(args: {
    limit: number;
  }): Promise<TalentIntakeOutboxEventRow[]> {
    const rows = await this.prisma.talentIntakeOutboxEvent.findMany({
      where: { published_at: null },
      orderBy: { created_at: 'asc' },
      take: args.limit,
    });
    return rows as unknown as TalentIntakeOutboxEventRow[];
  }

  async markTalentIntakeOutboxPublished(args: {
    event_ids: string[];
    published_at: Date;
  }): Promise<number> {
    if (args.event_ids.length === 0) {
      return 0;
    }
    const updated = await this.prisma.talentIntakeOutboxEvent.updateMany({
      where: { id: { in: args.event_ids } },
      data: { published_at: args.published_at },
    });
    return updated.count;
  }

  // ADR-0033 Decision 1 — concurrency-safe claim. Atomically lease up to `limit`
  // CLAIMABLE rows (unpublished, not quarantined, under the attempt budget, lease
  // absent/expired), OLDEST-FIRST, stamping lease_expires_at from DB now() (NOT
  // an app clock) and bumping publish_attempts. FOR UPDATE SKIP LOCKED lets
  // multiple publishers run without ever claiming the same row. Returns the
  // claimed rows in the canonical envelope shape.
  async claimTalentIntakeOutboxBatch(input: {
    limit: number;
    lease_seconds: number;
    max_attempts: number;
  }): Promise<TalentIntakeOutboxClaimRow[]> {
    const rows = await this.prisma.$queryRaw<TalentIntakeOutboxClaimRow[]>`
      UPDATE "talent_evidence"."TalentIntakeOutboxEvent" AS o
      SET "claimed_at" = now(),
          "lease_expires_at" = now() + make_interval(secs => ${input.lease_seconds}::double precision),
          "publish_attempts" = o."publish_attempts" + 1
      FROM (
        SELECT "id"
        FROM "talent_evidence"."TalentIntakeOutboxEvent"
        WHERE "published_at" IS NULL
          AND "quarantined_at" IS NULL
          AND "publish_attempts" < ${input.max_attempts}
          AND ("lease_expires_at" IS NULL OR "lease_expires_at" < now())
        ORDER BY "created_at" ASC
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      ) AS c
      WHERE o."id" = c."id"
      RETURNING o."id", o."tenant_id", o."event_type", o."event_payload",
                o."created_at", o."event_version", o."source", o."subject_type",
                o."subject_id", o."correlation_id", o."causation_id",
                o."publish_attempts"
    `;
    return rows;
  }

  // Release the lease on confirmed-FAILED rows → immediately reclaimable next
  // tick. Records last_publish_error; never sets published_at. Guarded so a row
  // that was published/quarantined meanwhile is untouched.
  async releaseTalentIntakeOutboxLease(input: {
    event_ids: string[];
    last_error: string;
  }): Promise<number> {
    if (input.event_ids.length === 0) {
      return 0;
    }
    const updated = await this.prisma.talentIntakeOutboxEvent.updateMany({
      where: { id: { in: input.event_ids }, published_at: null, quarantined_at: null },
      data: { claimed_at: null, lease_expires_at: null, last_publish_error: input.last_error },
    });
    return updated.count;
  }

  // Park non-transient / unmappable rows: stop claiming them, keep them visible.
  async quarantineTalentIntakeOutboxEvents(input: {
    event_ids: string[];
    reason: string;
  }): Promise<number> {
    if (input.event_ids.length === 0) {
      return 0;
    }
    const updated = await this.prisma.talentIntakeOutboxEvent.updateMany({
      where: { id: { in: input.event_ids }, published_at: null },
      data: { quarantined_at: new Date(), quarantine_reason: input.reason },
    });
    return updated.count;
  }

  // TI-1F-B — the ATOMIC promotion on CONFIRM (directive §4-E): in ONE
  // transaction, persist ALL accepted typed facts (work-history + per-role skill
  // usage + projects + declared skills + education + certifications, every row
  // already shaped by the caller and anchored on source_document_id — NEVER
  // source_edition_id, §4-F) and flip the draft READY_FOR_REVIEW → ACCEPTED. All
  // -or-none: the draft mark is guarded on READY_FOR_REVIEW inside the tx, so a
  // concurrent/duplicate confirm (count 0) throws and rolls back every insert —
  // no half-promoted evidence, no double-promotion. External ops (none here — the
  // grounded payload was persisted in A) stay outside the tx; trust projection +
  // reconciliation + the derived snapshot run AFTER commit (TI-1F-C). Prior
  // evidence is PRESERVED — these are additive creates, never a replace-set (§4-G).
  // Mirrors the inline-mapping transaction precedent of replaceWorkHistoryForTalent.
  async promoteResumeExtractionDraftEvidence(input: {
    draft_id: string;
    tenant_id: string;
    reviewed_by: string;
    reviewed_at: Date;
    work_history: readonly CreateTalentWorkHistoryEntryInput[];
    skill_evidence: readonly CreateTalentSkillEvidenceInput[];
    projects: readonly CreateTalentProjectExperienceInput[];
    education: readonly CreateTalentEducationEntryInput[];
    certifications: readonly CreateTalentCertificationEntryInput[];
  }): Promise<{
    work_history_ids: string[];
    skill_evidence_ids: string[];
    project_ids: string[];
    education_ids: string[];
    certification_ids: string[];
  }> {
    return this.prisma.$transaction(async (tx) => {
      const work_history_ids: string[] = [];
      for (const e of input.work_history) {
        await tx.talentWorkHistoryEntry.create({
          data: {
            id: e.id,
            talent_id: e.talent_id,
            tenant_id: e.tenant_id,
            employer_name: e.employer_name,
            role_title: e.role_title,
            start_date: e.start_date,
            end_date: e.end_date,
            location: e.location,
            employment_type: e.employment_type,
            description_text: e.description_text,
            source: e.source,
            source_document_id: e.source_document_id,
            source_refs: e.source_refs ?? [],
            source_map_version: e.source_map_version,
            resume_text_hash: e.resume_text_hash,
            company_id: e.company_id,
            experience_summary: e.experience_summary,
            is_authoritative: e.is_authoritative,
            created_at: e.created_at,
          },
        });
        work_history_ids.push(e.id);
      }
      const skill_evidence_ids: string[] = [];
      for (const s of input.skill_evidence) {
        await tx.talentSkillEvidence.create({
          data: {
            id: s.id,
            talent_id: s.talent_id,
            tenant_id: s.tenant_id,
            skill_id: s.skill_id,
            source_record_id: s.source_record_id,
            surface_form: s.surface_form,
            source: s.source,
            evidence_text: s.evidence_text,
            proficiency_claim: s.proficiency_claim,
            years_claimed: s.years_claimed,
            confidence_score: s.confidence_score,
            source_document_id: s.source_document_id,
            source_refs: s.source_refs ?? [],
            source_map_version: s.source_map_version,
            resume_text_hash: s.resume_text_hash,
            work_experience_id: s.work_experience_id,
            version: s.version,
            usage_start: s.usage_start,
            usage_end: s.usage_end,
            usage_period_basis: s.usage_period_basis,
            activity_context: s.activity_context,
            created_at: s.created_at,
          },
        });
        skill_evidence_ids.push(s.id);
      }
      const project_ids: string[] = [];
      for (const p of input.projects) {
        await tx.talentProjectExperience.create({
          data: {
            id: p.id,
            talent_id: p.talent_id,
            tenant_id: p.tenant_id,
            work_experience_id: p.work_experience_id,
            project_name: p.project_name,
            context_summary: p.context_summary,
            domain: p.domain,
            start_date: p.start_date,
            end_date: p.end_date,
            source_document_id: p.source_document_id,
            source_refs: p.source_refs ?? [],
            source_map_version: p.source_map_version,
            resume_text_hash: p.resume_text_hash,
            created_at: p.created_at,
          },
        });
        project_ids.push(p.id);
      }
      const education_ids: string[] = [];
      for (const ed of input.education) {
        await tx.talentEducationEntry.create({
          data: {
            id: ed.id,
            talent_id: ed.talent_id,
            tenant_id: ed.tenant_id,
            institution_name: ed.institution_name,
            degree_name: ed.degree_name,
            field_of_study: ed.field_of_study,
            conferred_date: ed.conferred_date,
            evidence_text: ed.evidence_text,
            source: ed.source,
            source_document_id: ed.source_document_id,
            source_refs: ed.source_refs ?? [],
            source_map_version: ed.source_map_version,
            resume_text_hash: ed.resume_text_hash,
            created_at: ed.created_at,
          },
        });
        education_ids.push(ed.id);
      }
      const certification_ids: string[] = [];
      for (const c of input.certifications) {
        await tx.talentCertificationEntry.create({
          data: {
            id: c.id,
            talent_id: c.talent_id,
            tenant_id: c.tenant_id,
            certification_name: c.certification_name,
            issuer_name: c.issuer_name,
            credential_ref: c.credential_ref,
            issued_date: c.issued_date,
            expiry_date: c.expiry_date,
            evidence_text: c.evidence_text,
            source: c.source,
            source_document_id: c.source_document_id,
            source_refs: c.source_refs ?? [],
            source_map_version: c.source_map_version,
            resume_text_hash: c.resume_text_hash,
            created_at: c.created_at,
          },
        });
        certification_ids.push(c.id);
      }
      // The atomic gate: promote ONLY a still-reviewable draft. A concurrent or
      // repeated confirm sees count 0 → throw → the whole tx (every insert above)
      // rolls back. No partial evidence, no double promotion (§3, §4-E).
      const marked = await tx.resumeExtractionDraft.updateMany({
        where: { id: input.draft_id, tenant_id: input.tenant_id, status: 'READY_FOR_REVIEW' },
        data: { status: 'ACCEPTED', reviewed_by: input.reviewed_by, reviewed_at: input.reviewed_at },
      });
      if (marked.count === 0) {
        throw new ResumeExtractionDraftNotReviewableError(input.draft_id);
      }
      return {
        work_history_ids,
        skill_evidence_ids,
        project_ids,
        education_ids,
        certification_ids,
      };
    });
  }

  // TI-1F-C — the CREATE_DRAFT_UPLOAD confirm lookup (by draft id, tenant-scoped).
  async findResumeExtractionDraftById(args: {
    tenant_id: string;
    id: string;
  }): Promise<ResumeExtractionDraftRow | null> {
    const row = await this.prisma.resumeExtractionDraft.findFirst({
      where: { id: args.id, tenant_id: args.tenant_id },
    });
    return (row as unknown as ResumeExtractionDraftRow | null) ?? null;
  }

  // TALENT-INTEL-1 TI-1F-C — PHASE 1 of the ordered, idempotent CREATE_DRAFT_UPLOAD
  // promotion (strengthened-D). In ONE talent_evidence transaction (single schema,
  // genuinely atomic) it establishes the accepted resume evidence lifecycle against
  // a RESERVED talent_id, WITHOUT finalizing the draft: create the resume
  // TalentDocument + its companion default TalentResumeEdition, persist ALL accepted
  // typed evidence (anchored on the document, §4-F), and LINK the draft to the
  // reserved talent_id/document/edition — the draft STAYS READY_FOR_REVIEW (NOT
  // ACCEPTED: ACCEPTED means "crossed into a durable ATS Talent", which only happens
  // after TalentRecord exists, phase 3). All-or-none: a mid-write failure rolls the
  // whole lifecycle back so a retry re-runs phase 1 cleanly. External ops (S3/model)
  // already happened in A; none run here. Mirrors the inline-mapping tx precedent.
  async establishCreateDraftEvidence(input: {
    tenant_id: string;
    talent_id: string;
    created_by: string;
    draft_id: string;
    document: {
      id: string;
      uploaded_by_actor_id: string;
      filename: string;
      file_storage_ref: string;
      mime_type: string;
      size_bytes: number;
      uploaded_at: Date;
    };
    edition: { id: string; content_hash: string; created_at: Date };
    resume_default_id: string;
    work_history: readonly CreateTalentWorkHistoryEntryInput[];
    skill_evidence: readonly CreateTalentSkillEvidenceInput[];
    projects: readonly CreateTalentProjectExperienceInput[];
    education: readonly CreateTalentEducationEntryInput[];
    certifications: readonly CreateTalentCertificationEntryInput[];
  }): Promise<{ document_id: string; edition_id: string }> {
    return this.prisma.$transaction(async (tx) => {
      // DOC-1b — mint the canonical Document quartet atomically in this tx.
      const canonicalDocumentId = await this.mintCanonicalDocument(tx, {
        tenant_id: input.tenant_id,
        talent_id: input.talent_id,
        document_type: 'resume',
        filename: input.document.filename,
        file_storage_ref: input.document.file_storage_ref,
        mime_type: input.document.mime_type,
        size_bytes: input.document.size_bytes,
        uploaded_by_actor_id: input.document.uploaded_by_actor_id,
        uploaded_at: input.document.uploaded_at,
        is_active: true,
      });
      await tx.talentDocument.create({
        data: {
          id: input.document.id,
          talent_id: input.talent_id,
          tenant_id: input.tenant_id,
          parse_status: 'parsed',
          consent_scope_at_upload: [],
          retention_policy: 'default',
          is_active: true,
          document_id: canonicalDocumentId,
        },
      });
      await tx.talentResumeEdition.create({
        data: {
          id: input.edition.id,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          talent_document_id: input.document.id,
          content_hash: input.edition.content_hash,
          created_at: input.edition.created_at,
          created_by: input.created_by,
          purpose: 'GENERAL',
        },
      });
      // First edition for the reserved Talent → its default (presentation only).
      await tx.talentResumeDefault.upsert({
        where: { tenant_id_talent_id: { tenant_id: input.tenant_id, talent_id: input.talent_id } },
        create: {
          id: input.resume_default_id,
          tenant_id: input.tenant_id,
          talent_id: input.talent_id,
          resume_edition_id: input.edition.id,
          set_at: input.edition.created_at,
          set_by: input.created_by,
        },
        update: {
          resume_edition_id: input.edition.id,
          set_at: input.edition.created_at,
          set_by: input.created_by,
        },
      });
      for (const e of input.work_history) {
        await tx.talentWorkHistoryEntry.create({
          data: {
            id: e.id, talent_id: e.talent_id, tenant_id: e.tenant_id,
            employer_name: e.employer_name, role_title: e.role_title,
            start_date: e.start_date, end_date: e.end_date, location: e.location,
            employment_type: e.employment_type, description_text: e.description_text,
            source: e.source, source_document_id: e.source_document_id,
            source_refs: e.source_refs ?? [], source_map_version: e.source_map_version,
            resume_text_hash: e.resume_text_hash, company_id: e.company_id,
            experience_summary: e.experience_summary, is_authoritative: e.is_authoritative,
            created_at: e.created_at,
          },
        });
      }
      for (const s of input.skill_evidence) {
        await tx.talentSkillEvidence.create({
          data: {
            id: s.id, talent_id: s.talent_id, tenant_id: s.tenant_id, skill_id: s.skill_id,
            source_record_id: s.source_record_id, surface_form: s.surface_form, source: s.source,
            evidence_text: s.evidence_text, proficiency_claim: s.proficiency_claim,
            years_claimed: s.years_claimed, confidence_score: s.confidence_score,
            source_document_id: s.source_document_id, source_refs: s.source_refs ?? [],
            source_map_version: s.source_map_version, resume_text_hash: s.resume_text_hash,
            work_experience_id: s.work_experience_id, version: s.version,
            usage_start: s.usage_start, usage_end: s.usage_end,
            usage_period_basis: s.usage_period_basis, activity_context: s.activity_context,
            created_at: s.created_at,
          },
        });
      }
      for (const p of input.projects) {
        await tx.talentProjectExperience.create({
          data: {
            id: p.id, talent_id: p.talent_id, tenant_id: p.tenant_id,
            work_experience_id: p.work_experience_id, project_name: p.project_name,
            context_summary: p.context_summary, domain: p.domain, start_date: p.start_date,
            end_date: p.end_date, source_document_id: p.source_document_id,
            source_refs: p.source_refs ?? [], source_map_version: p.source_map_version,
            resume_text_hash: p.resume_text_hash, created_at: p.created_at,
          },
        });
      }
      for (const ed of input.education) {
        await tx.talentEducationEntry.create({
          data: {
            id: ed.id, talent_id: ed.talent_id, tenant_id: ed.tenant_id,
            institution_name: ed.institution_name, degree_name: ed.degree_name,
            field_of_study: ed.field_of_study, conferred_date: ed.conferred_date,
            evidence_text: ed.evidence_text, source: ed.source,
            source_document_id: ed.source_document_id, source_refs: ed.source_refs ?? [],
            source_map_version: ed.source_map_version, resume_text_hash: ed.resume_text_hash,
            created_at: ed.created_at,
          },
        });
      }
      for (const c of input.certifications) {
        await tx.talentCertificationEntry.create({
          data: {
            id: c.id, talent_id: c.talent_id, tenant_id: c.tenant_id,
            certification_name: c.certification_name, issuer_name: c.issuer_name,
            credential_ref: c.credential_ref, issued_date: c.issued_date,
            expiry_date: c.expiry_date, evidence_text: c.evidence_text, source: c.source,
            source_document_id: c.source_document_id, source_refs: c.source_refs ?? [],
            source_map_version: c.source_map_version, resume_text_hash: c.resume_text_hash,
            created_at: c.created_at,
          },
        });
      }
      // LINK the draft to the reserved identity — but keep it READY_FOR_REVIEW.
      // ACCEPTED is written only in phase 3, after the TalentRecord exists.
      // CAS on talent_id IS NULL: only the FIRST concurrent confirm links; a second
      // (racing, different reserved id) sees count 0 → throws → its evidence rolls
      // back. Both then converge on the winner's reserved id via the controller's
      // idempotent retry (re-read → reuse the now-linked identity).
      const linked = await tx.resumeExtractionDraft.updateMany({
        where: {
          id: input.draft_id,
          tenant_id: input.tenant_id,
          status: 'READY_FOR_REVIEW',
          talent_id: null,
        },
        data: {
          talent_id: input.talent_id,
          talent_document_id: input.document.id,
          resume_edition_id: input.edition.id,
        },
      });
      if (linked.count === 0) {
        // Already linked (a concurrent/prior phase-1) or no longer reviewable →
        // roll back every write above (no orphan evidence for the losing racer).
        throw new ResumeExtractionDraftNotReviewableError(input.draft_id);
      }
      return { document_id: input.document.id, edition_id: input.edition.id };
    });
  }

  // TALENT-INTEL-1 TI-1D-C — the idempotency lookup for edition ingestion: a
  // TalentDocument has at most ONE edition (talent_document_id @unique). A retry
  // for the same document returns the existing edition instead of creating a
  // second (ruling B — talent_document_id is the edition-creation boundary).
  async findResumeEditionByDocumentId(
    talentDocumentId: string,
  ): Promise<TalentResumeEditionRow | null> {
    const row = await this.prisma.talentResumeEdition.findUnique({
      where: { talent_document_id: talentDocumentId },
    });
    return (row as TalentResumeEditionRow | null) ?? null;
  }

  // Resume Revision Lifecycle §4 — the exact-artifact dedup lookup: does this
  // Talent already have an edition whose artifact byte SHA-256 matches? Scoped to
  // (tenant, talent) — never cross-Talent, never cross-tenant (§4/§16). Returns
  // the EXISTING edition (any lifecycle_status, incl. archived — the artifact is
  // still "on the profile") so the caller can surface "already on this Talent's
  // profile — Revision N". Deterministic artifact equality only; the DB
  // UNIQUE(tenant, talent, artifact_sha256) is the race backstop.
  async findResumeEditionByArtifactSha256(args: {
    tenant_id: string;
    talent_id: string;
    artifact_sha256: string;
  }): Promise<TalentResumeEditionRow | null> {
    const row = await this.prisma.talentResumeEdition.findFirst({
      where: {
        tenant_id: args.tenant_id,
        talent_id: args.talent_id,
        artifact_sha256: args.artifact_sha256,
      },
      orderBy: { created_at: 'asc' },
    });
    return (row as TalentResumeEditionRow | null) ?? null;
  }

  // Resume Revision Lifecycle §8 — ARCHIVE a resume edition (active → archived).
  // Archive is NOT delete: the row, its artifact, and any historical Submittal
  // reference remain intact; the edition is merely excluded from ordinary
  // selectors and new requisition selection. Scoped to (tenant, talent) and
  // transitions ONLY from 'active' (never clobbers an explicit 'retracted');
  // re-archiving an already-archived edition is an idempotent no-op. No
  // un-archive in this increment (ACTIVE/ARCHIVED only, §8/§16). Returns the
  // current row (null if the edition is absent / not owned).
  async archiveResumeEdition(args: {
    tenant_id: string;
    talent_id: string;
    edition_id: string;
  }): Promise<TalentResumeEditionRow | null> {
    await this.prisma.talentResumeEdition.updateMany({
      where: {
        id: args.edition_id,
        tenant_id: args.tenant_id,
        talent_id: args.talent_id,
        lifecycle_status: 'active',
      },
      data: { lifecycle_status: 'archived' },
    });
    const row = await this.prisma.talentResumeEdition.findUnique({
      where: { id: args.edition_id },
    });
    return (row as TalentResumeEditionRow | null) ?? null;
  }

  // TALENT-INTEL-1 TI-1D-C — the edition COLLECTION for the read API, each row
  // projected with its TalentDocument metadata (filename/mime_type/uploaded_at)
  // and a default marker. Editions and TalentDocuments are same-schema
  // (talent_evidence), UUID-only-joined (no FK); the default is one-per-Talent
  // (LEFT JOIN, COALESCE→false when no default set). Newest-first, but the newest
  // is NOT the sole truth — the default marker is authoritative for presentation.
  async findResumeEditionsWithDocumentByTalent(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<TalentResumeEditionWithDocumentRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<Record<string, unknown>>
    >(
      // DOC-1b cutover — the document metadata (filename/mime_type/uploaded_at)
      // is sourced from the canonical documents.Document + its revision-1, reached
      // via the UUID-only TalentDocument.document_id link (no cross-schema FK).
      // filename→Document.title, mime_type→DocumentRevision.mime_type,
      // uploaded_at→Document.created_at. The output aliases are unchanged.
      `SELECT e.id, e.tenant_id, e.talent_id, e.talent_document_id, e.attachment_id,
              e.content_hash, e.artifact_sha256, e.purpose, e.label, e.requisition_id,
              e.client_context_id,
              e.derived_from_edition_id, e.lifecycle_status, e.created_at, e.created_by,
              doc.title AS document_filename, rev.mime_type AS document_mime_type,
              doc.created_at AS document_uploaded_at,
              COALESCE(df.resume_edition_id = e.id, false) AS is_default,
              dr.status AS processing_status
         FROM "talent_evidence"."TalentResumeEdition" e
         JOIN "talent_evidence"."TalentDocument" td ON td.id = e.talent_document_id
         JOIN "documents"."Document" doc ON doc.id = td.document_id
         JOIN "documents"."DocumentRevision" rev
           ON rev.document_id = doc.id AND rev.revision_number = 1
         LEFT JOIN "talent_evidence"."TalentResumeDefault" df
           ON df.tenant_id = e.tenant_id AND df.talent_id = e.talent_id
         -- TI-1F-A: processing_status is DERIVED from the edition's
         -- ResumeExtractionDraft (no new source of truth). NULL for editions
         -- created before TI-1F-A (no draft) — projected as null.
         LEFT JOIN "talent_evidence"."ResumeExtractionDraft" dr
           ON dr.tenant_id = e.tenant_id AND dr.resume_edition_id = e.id
        WHERE e.tenant_id = $1 AND e.talent_id = $2
        ORDER BY e.created_at DESC`,
      args.tenant_id,
      args.talent_id,
    );
    return rows.map((r) => ({
      id: r['id'] as string,
      tenant_id: r['tenant_id'] as string,
      talent_id: r['talent_id'] as string,
      talent_document_id: r['talent_document_id'] as string,
      attachment_id: (r['attachment_id'] as string | null) ?? null,
      content_hash: r['content_hash'] as string,
      artifact_sha256: (r['artifact_sha256'] as string | null) ?? null,
      purpose: r['purpose'] as TalentResumeEditionPurposeValue,
      label: (r['label'] as string | null) ?? null,
      requisition_id: (r['requisition_id'] as string | null) ?? null,
      client_context_id: (r['client_context_id'] as string | null) ?? null,
      derived_from_edition_id: (r['derived_from_edition_id'] as string | null) ?? null,
      lifecycle_status: r['lifecycle_status'] as TalentResumeEditionLifecycleValue,
      created_at: r['created_at'] as Date,
      created_by: r['created_by'] as string,
      document_filename: r['document_filename'] as string,
      document_mime_type: r['document_mime_type'] as string,
      document_uploaded_at: r['document_uploaded_at'] as Date,
      is_default: r['is_default'] === true,
      processing_status:
        (r['processing_status'] as ResumeExtractionDraftStatusValue | null) ?? null,
    }));
  }

  // ---- TalentDerivedSnapshot -----------------------------------------

  async createTalentDerivedSnapshot(
    input: CreateTalentDerivedSnapshotInput,
  ): Promise<TalentDerivedSnapshotRow> {
    const created = await this.prisma.talentDerivedSnapshot.create({
      data: {
        id: input.id,
        talent_id: input.talent_id,
        tenant_id: input.tenant_id,
        skill_confidence_scores: input.skill_confidence_scores as never,
        estimated_years_experience_overall: input.estimated_years_experience_overall,
        estimated_years_experience_by_skill: input.estimated_years_experience_by_skill as never,
        estimated_years_experience_by_canonical_skill:
          input.estimated_years_experience_by_canonical_skill as never,
        skill_domains: input.skill_domains as never,
        career_trajectory_pattern: input.career_trajectory_pattern,
        intent_signal: input.intent_signal as never,
        freshness_score: input.freshness_score as never,
        reachability_score: input.reachability_score as never,
        availability_confidence: input.availability_confidence,
        trust_level: input.trust_level,
        data_completeness_score: input.data_completeness_score,
        threshold_status: input.threshold_status as never,
        current_consent_state: input.current_consent_state as never,
        computed_at: input.computed_at,
      },
    });
    return created as TalentDerivedSnapshotRow;
  }

  async findTalentDerivedSnapshotById(
    id: string,
  ): Promise<TalentDerivedSnapshotRow | null> {
    const row = await this.prisma.talentDerivedSnapshot.findUnique({ where: { id } });
    return (row as TalentDerivedSnapshotRow | null) ?? null;
  }

  // SKILL-TAX-1G — the latest derived snapshot for a talent (the canonical
  // interval-union years projection attaches to it; NULL when none exists yet —
  // 1G never fabricates a snapshot).
  async findLatestDerivedSnapshot(args: {
    tenant_id: string;
    talent_id: string;
  }): Promise<{ id: string } | null> {
    const row = await this.prisma.talentDerivedSnapshot.findFirst({
      where: { tenant_id: args.tenant_id, talent_id: args.talent_id },
      orderBy: { computed_at: 'desc' },
      select: { id: true },
    });
    return row ?? null;
  }

  async updateDerivedSnapshotCanonicalYears(id: string, canonicalYears: unknown): Promise<void> {
    await this.prisma.talentDerivedSnapshot.update({
      where: { id },
      data: { estimated_years_experience_by_canonical_skill: canonicalYears as never },
    });
  }

  // ---- Resolution re-point (TR-2a-B3b) -------------------------------
  // TR-2a-B3b (DDR-3 §4) — OPERATIONAL re-point across ALL seven talent_evidence
  // holders (talent_id → TalentRecord.id). One method, one UPDATE per model,
  // tenant-scoped, RETURNING id. Idempotent (re-run matches nothing). No unique key
  // involves talent_id in any of the seven → no collision → removed_rows always [].
  //
  // REVERSAL (DDR-3 §4) — an optional `only_ids` restricts each per-model
  // UPDATE to a specific id set (`AND id = ANY($4::uuid[])`), so a prior
  // forward re-point can be re-pointed back for EXACTLY the rows it moved.
  // Absent/empty behaves as the whole-tenant re-point above.
  async repointTalentRecordRefs(args: {
    tenant_id: string;
    from_record_id: string;
    to_record_id: string;
    only_ids?: string[];
  }): Promise<{ repointed_ids: string[]; removed_rows: unknown[] }> {
    const tables = [
      'TalentSkillEvidence',
      'TalentWorkHistoryEntry',
      'TalentContactMethod',
      'TalentRateExpectation',
      'TalentWorkAuthorization',
      'TalentDocument',
      'TalentDerivedSnapshot',
      // TR-15 B2R — the two TR-7 B1 credential holders were born without their
      // reconcile-repoint membership (the defect the T15-B2 erasure inventory
      // surfaced). Same talent_id/tenant_id shape as the seven above → the
      // generic UPDATE re-points them loser→survivor, and their ids ride back in
      // repointed_ids so the reversal (only_ids) re-points them exactly.
      'TalentEducationEntry',
      'TalentCertificationEntry',
    ];
    const base: unknown[] = [args.to_record_id, args.from_record_id, args.tenant_id];
    let idFilter = '';
    if (args.only_ids && args.only_ids.length > 0) {
      base.push(args.only_ids);
      idFilter = 'AND id = ANY($4::uuid[])';
    }
    const ids: string[] = [];
    for (const t of tables) {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "talent_evidence"."${t}" SET talent_id = $1::uuid
           WHERE talent_id = $2::uuid AND tenant_id = $3::uuid ${idFilter}
         RETURNING id`,
        ...base,
      );
      ids.push(...rows.map((r) => r.id));
    }
    // DOC-1b — the documents.DocumentAssociation talent link uses resource_id
    // (there is no talent_id column), so the generic loop above misses it. This
    // is exactly the omission class the education/certification erasure gap
    // flagged; re-point it explicitly (resource_type='TALENT', loser→survivor).
    await this.prisma.$executeRawUnsafe(
      `UPDATE "documents"."DocumentAssociation" SET "resource_id" = $1::uuid
         WHERE "resource_id" = $2::uuid AND "tenant_id" = $3::uuid AND "resource_type" = 'TALENT'`,
      args.to_record_id,
      args.from_record_id,
      args.tenant_id,
    );
    return { repointed_ids: ids, removed_rows: [] };
  }
}
