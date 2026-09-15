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

// ── Résumé-draft (pre-create) extraction — HF1 durable fact extraction ───────
// The Add-Talent governed-LLM intake PROPOSAL. A DRAFT for the recruiter to
// review — NOT persisted evidence, NOT a verified claim, NOT TalentRecord-keyed.
//
// HF1 (Durable-Fact-Extraction-Directive v1.0) architecture:
//   - SINGLE-READ, FACT-ONLY, SOURCE-REFERENCED (§2/R3). The model returns the
//     structured facts the Add-Talent domain needs PLUS compact `source_refs`
//     (source-map block ids) — NEVER copied résumé prose / `source_excerpt`.
//   - Work-history carries NO free-text `description` (R4): structured facts only.
//   - Grounding (§5/R5) resolves `source_refs` against the Aramo-OWNED source-map
//     (below), validating each fact locally — the model's reference alone is not
//     proof.
//   - Email/phone are DELIBERATELY absent + redacted before the model (§17/R10).

// HF1 §3 — the canonical résumé source-map, CONSUMER copy. The authoritative
// builder lives in @aramo/resume-parse (the bytes→text owner); this lib grounds
// against a structurally-identical value passed BY VALUE through the controller
// seam, so talent-extraction takes NO import edge on resume-parse (R1).
export interface SourceMapBlock {
  block_id: string;
  text: string;
  char_start: number;
  char_end: number;
}

export interface ResumeSourceMap {
  version: string;
  text_hash: string;
  blocks: readonly SourceMapBlock[];
}

export interface ResumeDraftInput {
  tenant_id: string;
  // The Aramo-owned source-map (built by resume-parse). The grounding corpus
  // AND the input rendering are derived from it — there is no separate text arg.
  source_map: ResumeSourceMap;
}

// HF1 §13/R9 — explicit, distinct extraction outcome states. A technical
// failure NEVER masquerades as a "successful extraction with zero facts".
export type ResumeDraftStatus =
  | 'success' // structured output grounded; facts present
  | 'partial' // structured output ok, but some facts rejected / none grounded
  | 'provider_truncated' // stop_reason=max_tokens — output did not complete
  | 'invalid_structured_output' // provider returned unparseable / off-schema output
  | 'provider_failure'; // transport / auth / rate-limit / server error

// ── The compact shape the model returns (facts + source_refs ONLY) ───────────
// Every group/item carries `source_refs: string[]` (source-map block ids) in
// place of the retired `source_excerpt`. No copied prose; no work-history
// `description`.
export interface ResumeDraftIdentity {
  first_name?: string;
  last_name?: string;
  source_refs: string[];
}

export interface ResumeDraftLocation {
  address?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  source_refs: string[];
}

export interface ResumeDraftProfessional {
  current_employer?: string;
  title?: string;
  source_refs: string[];
}

export interface ResumeDraftSkillFact {
  surface_form: string;
  source_refs: string[];
}

export interface ResumeDraftWorkHistoryFact {
  employer_name: string;
  role_title: string;
  start_date?: string;
  end_date?: string;
  employment_type?: string;
  source_refs: string[];
}

export interface ResumeDraftCompletion {
  identity?: ResumeDraftIdentity;
  location?: ResumeDraftLocation;
  professional?: ResumeDraftProfessional;
  skills: ResumeDraftSkillFact[];
  work_history: ResumeDraftWorkHistoryFact[];
}

// HF1 R7 — a grounded, structured skill carrying its durable source provenance.
// Carried through the proposal path (NOT immediately reduced to key_skills).
export interface ResumeDraftSkill {
  surface_form: string;
  source_refs: string[];
}

// One reviewable work-history entry in the proposal (grounded, editable). Maps
// to a TalentWorkHistoryEntry (source='resume') on create.
//   - `source_refs` (HF1 §16/R8): durable block-level provenance, carried
//     through extraction → API → FE review → the persistence seam.
//   - `description` is RETAINED (optional) for the recruiter-driven full-profile
//     EDIT path only; HF1 extraction NEVER populates it (R4 — no narrative).
export interface ResumeDraftWorkHistory {
  employer_name: string;
  role_title: string;
  start_date?: string;
  end_date?: string;
  employment_type?: string;
  description?: string;
  source_refs?: string[];
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
// was resolved against the source-map (ref exists AND the block text supports
// the value); ungrounded items were dropped and counted. Maps onto the
// Add-Talent intake fields the recruiter then reviews/edits.
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
  // HF1 R7 — structured, grounded skills with durable source provenance. The
  // controller derives the free-text key_skills from these (surface forms); the
  // structured list + refs survive through the API for durable persistence.
  skills: ResumeDraftSkill[];
  // Reviewable, grounded work-history entries (declared, source='resume'),
  // each carrying its source_refs (§16/R8).
  work_history: ResumeDraftWorkHistory[];
  rejected_count: number;
  // HF1 §16 — provenance anchors (which corpus these refs resolve against).
  source_map_version: string;
  resume_text_hash: string;
}

// HF1 §13/R9 — the extraction RESULT: an explicit status + the grounded
// proposal. extractResumeDraft returns this (it no longer throws on a provider
// failure — the failure becomes an explicit status the caller surfaces).
export interface ResumeDraftResult {
  status: ResumeDraftStatus;
  proposal: ResumeDraftProposal;
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
