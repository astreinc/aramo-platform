// Gate-1 G1-A — TalentExtractionService I/O contracts.

// The declared source the extraction reads FROM. The caller (the G1-B
// derivation/endpoint) supplies the already-parsed declared text — the redacted
// résumé body + the recruiter-entered key_skills — so this lib stays a pure
// extract→persist service (no talent-record read edge). CONSTRAINED-TO-SOURCE:
// nothing is extracted that is not verbatim present in this text.
export interface ExtractDeclaredEvidenceInput {
  tenant_id: string;
  // The talent's OWN TalentRecord.id (post-ADR-0016 the evidence spine is
  // TalentRecord-keyed).
  talent_id: string;
  // Redacted résumé body text (TalentResumeText.redacted_text) — optional; a
  // talent may have no résumé on file.
  resume_text?: string;
  // The recruiter-entered free-text key_skills string — optional.
  key_skills?: string;
}

// The structured shape the LLM is instructed to return (strict JSON). Each item
// MUST carry a `source_excerpt` copied verbatim from the source text; items
// without one (or whose excerpt is not found in the source) are REJECTED
// (constrained-to-source guardrail — no inference/enrichment).
export interface ExtractedSkill {
  surface_form: string;
  source_excerpt: string;
  // Only populated when explicitly stated in the source.
  proficiency_claim?: string;
  years_claimed?: number;
}

export interface ExtractedWorkHistory {
  employer_name: string;
  role_title: string;
  source_excerpt: string;
  // Only populated when explicitly stated in the source.
  start_date?: string;
  end_date?: string;
  employment_type?: string;
  description?: string;
}

// TR-7 B1 — declared academic credential + professional certification. Same
// constrained-to-source contract: institution+degree / name are required, dates
// only when explicitly stated, every item carries a verbatim source_excerpt.
export interface ExtractedEducation {
  institution_name: string;
  degree_name: string;
  source_excerpt: string;
  field_of_study?: string;
  conferred_date?: string;
}

export interface ExtractedCertification {
  certification_name: string;
  source_excerpt: string;
  issuer_name?: string;
  credential_ref?: string;
  issued_date?: string;
  expiry_date?: string;
}

export interface ExtractionCompletion {
  skills: ExtractedSkill[];
  work_history: ExtractedWorkHistory[];
  // TR-7 B1 — the two new declared-evidence classes.
  education: ExtractedEducation[];
  certifications: ExtractedCertification[];
}

// ── Résumé-draft (pre-create) extraction ─────────────────────────────────────
// The Add-Talent governed-LLM intake PROPOSAL (LOCKED: "Add Talent — Governed
// LLM Resume Extraction + Deterministic Fallback"). This is a DRAFT for the
// recruiter to review — NOT persisted evidence, NOT a verified claim, NOT
// TalentRecord-keyed (no talent_id). Same constrained-to-source guardrail as
// the evidence extractor: every value carries a verbatim source_excerpt or is
// dropped. Email/phone are DELIBERATELY absent — AiDraftService redacts them
// before the model (Decision 6 PII redaction), so contact anchors come from the
// deterministic parser, not the LLM.
export interface ResumeDraftInput {
  tenant_id: string;
  resume_text?: string;
  key_skills?: string;
}

export interface ResumeDraftIdentity {
  first_name?: string;
  last_name?: string;
  source_excerpt: string;
}

export interface ResumeDraftLocation {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  source_excerpt: string;
}

export interface ResumeDraftProfessional {
  current_employer?: string;
  title?: string;
  source_excerpt: string;
}

// The raw shape the LLM is instructed to return for a draft proposal.
export interface ResumeDraftCompletion {
  identity?: ResumeDraftIdentity;
  location?: ResumeDraftLocation;
  professional?: ResumeDraftProfessional;
  skills: ExtractedSkill[];
  // Reviewable work-history entries (LOCKED scope expansion). Reuses the
  // ExtractedWorkHistory shape (employer/role/dates/description + verbatim
  // excerpt). These are DECLARED (source='resume'), NOT verified.
  work_history: ExtractedWorkHistory[];
}

// One reviewable work-history entry in the proposal (grounded, editable). Maps
// to a TalentWorkHistoryEntry (source='resume') on create.
export interface ResumeDraftWorkHistory {
  employer_name: string;
  role_title: string;
  start_date?: string;
  end_date?: string;
  employment_type?: string;
  description?: string;
}

// Talent-detail work-history read (LOCKED scope expansion). What was persisted,
// for display. `verified` is ALWAYS false at this stage — these are DECLARED
// ('from résumé'), not independently verified (ADR-0015 v1.3 §4.3); a later
// verification pass is what would flip it (the green VERIFIED badge).
export interface TalentWorkHistoryView {
  id: string;
  employer_name: string;
  role_title: string;
  start_date: string | null;
  end_date: string | null;
  employment_type: string | null;
  description: string | null;
  source: string;
  verified: boolean;
}

// The validated, grounded proposal returned to the caller. Every present value
// was found verbatim in the source; ungrounded items were dropped and counted.
// Maps 1:1 onto the Add-Talent intake fields the recruiter then reviews/edits.
export interface ResumeDraftProposal {
  first_name?: string;
  last_name?: string;
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  current_employer?: string;
  title?: string;
  skills: string[];
  // Reviewable, grounded work-history entries (declared, source='resume').
  work_history: ResumeDraftWorkHistory[];
  rejected_count: number;
}

// What TalentExtractionService persisted (declared evidence rows). Ids of the
// rows written; the counts let a caller log/telemeter the yield.
export interface ExtractDeclaredEvidenceResult {
  skill_evidence_ids: string[];
  work_history_ids: string[];
  // TR-7 B1 — the education/certification typed-row ids.
  education_ids: string[];
  certification_ids: string[];
  // Items the LLM proposed but the constrained-to-source guardrail rejected
  // (no valid source_excerpt). Surfaced for observability, never persisted.
  rejected_count: number;
}
