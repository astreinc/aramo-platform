// New Requisition AI intake — the PRE-CREATION generation DTOs (charter
// §7.3, Lead ruling Tab 1: "fold paste into the AI lane"). A single intake
// box (a pasted client email OR a few hiring-manager lines) is sent to the
// LLM, which EXTRACTS the stated requisition fields and DRAFTS a role
// description + required / nice-to-have requirement skills. The result lands
// in EDITABLE form fields tagged 'ai' — the recruiter reviews, edits, and
// commits every field via the normal create flow. The AI never saves
// (R8/R12). This is the 2nd declared libs/ai-draft consumer's pre-creation
// sibling to /:id/profile/draft (same lib, ADR-0015 v1.2 — no new amendment).
//
// R10 boundary: the generator drafts a ROLE description + REQUIREMENT skills
// (describing a job) and extracts STATED facts. It never assesses, scores, or
// ranks any person; the skills are req requirements, NOT a match profile.

// POST /v1/requisitions/intake
export interface IntakeDraftRequestDto {
  // The pasted client email OR a few hiring-manager lines. Size-limited at
  // the service boundary (INTAKE_TEXT_MAX_CHARS).
  intake_text: string;
  max_tokens?: number;
}

// Stated requisition facts the model extracted from the intake text. ALL
// optional + advisory — each lands editable + 'ai'-tagged for the recruiter
// to CONFIRM (extraction-of-stated-text, recruiter-confirms; never silently
// committed). `company_name` is a string HINT only — the recruiter still
// resolves the company via the picker (company_id is a UUID FK). Money /
// dates / duration are stated text, not normalized.
export interface IntakeExtractedFields {
  title?: string;
  company_name?: string;
  hiring_manager?: string;
  job_type?: string;
  seniority_level?: string;
  role_family?: string;
  openings?: number;
  city?: string;
  state?: string;
  work_arrangement?: string;
  work_authorization?: string;
  bill_rate?: string;
  rate_type?: string;
  allow_subcontractors?: boolean;
  duration_value?: number;
  duration_unit?: string;
  start_date?: string;
}

export interface IntakeSkill {
  name: string;
}

export interface IntakeDraftResponseDto {
  fields: IntakeExtractedFields;
  jd_text: string;
  required_skills: IntakeSkill[];
  nice_to_have_skills: IntakeSkill[];
  // Cross-reference to the libs/ai-draft audit record (the generation's
  // prompt-shape / model / tokens are logged there under this id — G2).
  ai_draft_audit_record_id: string;
}
