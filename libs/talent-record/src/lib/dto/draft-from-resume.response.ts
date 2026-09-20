import type { ParseStatus, TalentRecordPrefill } from '@aramo/resume-parse';
import type {
  ResumeDraftCertification,
  ResumeDraftEducation,
  ResumeDraftSkill,
  ResumeDraftStatus,
  ResumeDraftWorkHistory,
} from '@aramo/talent-extraction';

// POST /v1/talent-records/draft-from-resume response.
//
// Governed LLM is the SOLE production résumé fact extractor (TI-1F P0.2;
// …-TI-1F-…-v1_0-LOCKED §4-D). Deterministic résumé FACT extraction is retired:
// there is no mode field and no silent fallback to the heuristic parser.
// `warning` is set only when governed extraction could not run/produce (provider
// unavailable, malformed output, text-extraction failed) — the form opens with
// an empty prefill + a retry affordance; the heuristic parser never contributes.
export interface DraftFromResumeResponse {
  prefill: TalentRecordPrefill;
  parse_status: ParseStatus;
  warning?: string;
  // TALENT-INTEL-1 (TI-1F-A) — ADDITIVE + OPTIONAL. The id of the durable
  // CREATE_DRAFT_UPLOAD ResumeExtractionDraft persisted from THIS same governed
  // result (no second model call). Present only when the draft persisted; the
  // current Create form ignores it (the synchronous prefill above stays the
  // user-facing authority in A). TI-1F-C consumes it for the async review UX.
  draft_id?: string;
  // HF1 §13/R9 — the explicit governed-LLM extraction outcome. Lets the FE
  // distinguish a technical failure (provider_truncated / invalid_structured_output
  // / provider_failure) from an honest partial/empty result — a technical failure
  // never masquerades as a successful empty draft.
  extraction_status?: ResumeDraftStatus;
  // Reviewable, grounded work-history entries (declared 'from résumé', NOT
  // verified), each carrying its source_refs (§16/R8). The recruiter edits these
  // in the review card; on create they persist as TalentWorkHistoryEntry
  // (source='resume').
  work_history?: ResumeDraftWorkHistory[];
  // HF1 R7 — structured, grounded skills with durable source_refs. The form uses
  // the free-text prefill.key_skills; this preserves skill-level provenance
  // through the API for durable persistence.
  skills?: ResumeDraftSkill[];
  // HF2 R8/R18/R19 — reviewable, grounded education + certifications (declared
  // 'from résumé', NOT verified). The recruiter reviews these in the review card;
  // on create they persist as declared evidence with provenance.
  education?: ResumeDraftEducation[];
  certifications?: ResumeDraftCertification[];
  // HF1 §16 — the provenance anchors the FE carries back into the create request
  // (resume_document.source_map_version / resume_text_hash) so the persisted
  // evidence records which corpus its source_refs resolve against.
  source_map_version?: string;
  resume_text_hash?: string;
}
