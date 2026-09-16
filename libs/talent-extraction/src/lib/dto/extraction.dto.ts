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

// ── HF2 v3 — nested intelligence facts (shared by model-completion + grounded
// proposal; dates stay strings end-to-end, persistence parses them). Every one
// carries its OWN source_refs so grounding validates it INDEPENDENTLY (R-boundary:
// one bad nested fact must not destroy an otherwise-valid WorkExperience). ──

// HF2 P4 ruling — the two grounding classes. A resolving source_ref proves the
// cited block EXISTS; it does NOT prove a model-written paraphrase is
// semantically supported. So Aramo distinguishes:
//   DIRECT_FACT — a value locally substring-grounded against its source block
//     (skill surface_form, version, employer, role_title, dates, education,
//     certification, a NAMED project, a grounded metric).
//   SOURCE_ASSOCIATED_INTERPRETATION — a model-produced compact interpretation
//     carrying valid source_refs; résumé-DERIVED, NOT independently verified and
//     NOT value-validated (experience_summary, assertion.statement,
//     project.context, activity classification). The refs still resolve and
//     invented metrics/named-projects are still rejected — but downstream (Vector
//     / KG / matching) MUST treat these as interpretations, not verified facts.
export type GroundingClass = 'DIRECT_FACT' | 'SOURCE_ASSOCIATED_INTERPRETATION';

// R3/R16 — a time-aware, per-experience skill usage. surface_form + version are
// DIRECT_FACT (substring-grounded); `activity` is a SOURCE_ASSOCIATED_
// INTERPRETATION (a governed classification, not verbatim text).
// usage_period_basis distinguishes EXPLICIT (résumé stated the skill's own
// dates → usage_start/end carried) from WORK_EXPERIENCE_CONTEXT (dates NOT
// carried here; Aramo resolves the effective interval from the parent
// WorkExperience at derivation time — P4 ruling) from UNKNOWN.
export interface ResumeDraftSkillUsage {
  surface_form: string;
  version?: string;
  activity?: string;
  usage_start?: string;
  usage_end?: string;
  usage_period_basis?: string;
  source_refs: string[];
}

// R6 — a project/initiative within a role. project_name (when present) is a
// DIRECT_FACT (grounded, never invented — NULLABLE when unnamed); `context` is a
// SOURCE_ASSOCIATED_INTERPRETATION.
export interface ResumeDraftProject {
  project_name?: string;
  context?: string;
  domain?: string;
  start_date?: string;
  end_date?: string;
  source_refs: string[];
}

// R7 — an atomic activity/accomplishment claim (routed to EvidenceRecord at
// create, P5). `type`(governed classification) + `statement`(paraphrase) are a
// SOURCE_ASSOCIATED_INTERPRETATION — hence grounding_class is carried explicitly
// so persistence/Vector/KG never mistake it for a verified fact. `metric` is a
// DIRECT_FACT: kept ONLY when it substring-grounds (never invented, R17).
export interface ResumeDraftAssertion {
  type: string;
  statement: string;
  metric?: string;
  // Consumer-SET on every grounded proposal assertion (the model never returns
  // it); always SOURCE_ASSOCIATED_INTERPRETATION. Optional on the interface only
  // because the transient model-completion shape omits it.
  grounding_class?: GroundingClass;
  source_refs: string[];
}

// R8/R18 — declared education fact with HF1-style provenance.
export interface ResumeDraftEducation {
  institution_name: string;
  degree_name: string;
  field_of_study?: string;
  conferred_date?: string;
  source_refs: string[];
}

// R8/R19 — declared certification fact with HF1-style provenance.
export interface ResumeDraftCertification {
  certification_name: string;
  issuer_name?: string;
  credential_ref?: string;
  issued_date?: string;
  expiry_date?: string;
  version_or_level?: string;
  source_refs: string[];
}

export interface ResumeDraftWorkHistoryFact {
  employer_name: string;
  role_title: string;
  start_date?: string;
  end_date?: string;
  employment_type?: string;
  location?: string;
  // HF2 R10 — recruiter-facing summary (≤600, provider + consumer capped).
  experience_summary?: string;
  source_refs: string[];
  // HF2 nested intelligence (optional in model output — a role may state none).
  skill_usage?: ResumeDraftSkillUsage[];
  projects?: ResumeDraftProject[];
  assertions?: ResumeDraftAssertion[];
}

export interface ResumeDraftCompletion {
  identity?: ResumeDraftIdentity;
  location?: ResumeDraftLocation;
  professional?: ResumeDraftProfessional;
  skills: ResumeDraftSkillFact[];
  work_history: ResumeDraftWorkHistoryFact[];
  // HF2 R8/R18/R19 — declared education + certification, now IN the Add-Talent
  // draft path (were previously only on the separate examine path).
  education: ResumeDraftEducation[];
  certifications: ResumeDraftCertification[];
}

// HF1 R7 — a grounded, structured skill carrying its durable source provenance.
// Carried through the proposal path (NOT immediately reduced to key_skills).
export interface ResumeDraftSkill {
  surface_form: string;
  source_refs: string[];
}

// HF1 §16/R1/R8 — the shared durable-provenance anchors for résumé-derived
// evidence persisted at confirmed-create time: the résumé TalentDocument id and
// which source-map corpus (version + text hash) the per-item source_refs resolve
// against. All optional — absent ⇒ rows persist with NULL/empty provenance.
export interface ResumeProvenance {
  source_document_id?: string;
  source_map_version?: string;
  resume_text_hash?: string;
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
  location?: string;
  // `description` retained for the recruiter EDIT path; HF2 populates the bounded
  // `experience_summary` (≤600, R10) as the recruiter-facing role summary.
  description?: string;
  experience_summary?: string;
  source_refs?: string[];
  // HF2 nested intelligence (grounded, carried to the persistence seam in P6).
  skill_usage?: ResumeDraftSkillUsage[];
  projects?: ResumeDraftProject[];
  assertions?: ResumeDraftAssertion[];
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
  // each carrying its source_refs (§16/R8) + nested skill_usage/projects/assertions.
  work_history: ResumeDraftWorkHistory[];
  // HF2 R8/R18/R19 — declared education + certification (grounded).
  education: ResumeDraftEducation[];
  certifications: ResumeDraftCertification[];
  rejected_count: number;
  // HF2 R12 — TRUE when any array hit its cardinality ceiling and overflow was
  // truncated. Overflow is never silent: the caller surfaces it (status→partial +
  // this flag). The WorkExperience source_refs still span all blocks, so the
  // complete source evidence remains retrievable from the source-map.
  overflow: boolean;
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
  // HF2 R17 — email/phone CAPTURED during model-input redaction (never sent to
  // the model; ADR-0015 Decision-6 / §17). The controller merges these into the
  // recruiter prefill. Absent on the pre-model failure paths (empty prefill).
  contact?: { emails: string[]; phones: string[] };
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
