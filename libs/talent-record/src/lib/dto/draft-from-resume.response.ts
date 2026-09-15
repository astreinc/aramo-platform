import type { ResumeExtractionMode } from '@aramo/settings';
import type { ParseStatus, TalentRecordPrefill } from '@aramo/resume-parse';
import type {
  ResumeDraftCertification,
  ResumeDraftEducation,
  ResumeDraftSkill,
  ResumeDraftStatus,
  ResumeDraftWorkHistory,
} from '@aramo/talent-extraction';

// POST /v1/talent-records/draft-from-resume response (LOCKED: "Add Talent —
// Governed LLM Resume Extraction + Deterministic Fallback").
//
// MODE IS EXCLUSIVE (per the PO ruling): the tenant's resume.extraction_mode
// determines the sole résumé-to-prefill extractor.
//   - governed_llm  → the governed LLM (@aramo/talent-extraction) is the ONLY
//                     extractor; the deterministic parser does not contribute.
//   - deterministic → the deterministic parser is the ONLY extractor; NO LLM
//                     call occurs.
//
// Backward-compatible with the prior { prefill, parse_status } response (§21):
// `mode` and `warning` are additive. `warning` is set only when governed
// extraction could not run/produce (provider unavailable, malformed output,
// text-extraction failed) — the form opens with an empty prefill + a retry
// affordance; there is NO silent fallback to the deterministic parser (§15).
export interface DraftFromResumeResponse {
  mode: ResumeExtractionMode;
  prefill: TalentRecordPrefill;
  parse_status: ParseStatus;
  warning?: string;
  // HF1 §13/R9 — the explicit governed-LLM extraction outcome (governed_llm mode
  // only). Lets the FE distinguish a technical failure (provider_truncated /
  // invalid_structured_output / provider_failure) from an honest partial/empty
  // result — a technical failure never masquerades as a successful empty draft.
  extraction_status?: ResumeDraftStatus;
  // Reviewable, grounded work-history entries (governed_llm mode only; declared
  // 'from résumé', NOT verified), each carrying its source_refs (§16/R8). The
  // recruiter edits these in the review card; on create they persist as
  // TalentWorkHistoryEntry (source='resume').
  work_history?: ResumeDraftWorkHistory[];
  // HF1 R7 — structured, grounded skills with durable source_refs. The form uses
  // the free-text prefill.key_skills; this preserves skill-level provenance
  // through the API for durable persistence.
  skills?: ResumeDraftSkill[];
  // HF2 R8/R18/R19 — reviewable, grounded education + certifications (governed_llm
  // mode only; declared 'from résumé', NOT verified). The recruiter reviews these
  // in the review card; on create they persist as declared evidence with provenance.
  education?: ResumeDraftEducation[];
  certifications?: ResumeDraftCertification[];
  // HF1 §16 — the provenance anchors the FE carries back into the create request
  // (resume_document.source_map_version / resume_text_hash) so the persisted
  // evidence records which corpus its source_refs resolve against.
  source_map_version?: string;
  resume_text_hash?: string;
}
