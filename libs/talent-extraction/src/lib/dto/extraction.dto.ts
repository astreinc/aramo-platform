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
