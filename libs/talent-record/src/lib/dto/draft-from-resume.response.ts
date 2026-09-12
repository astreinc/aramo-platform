import type { ResumeExtractionMode } from '@aramo/settings';
import type { ParseStatus, TalentRecordPrefill } from '@aramo/resume-parse';
import type { ResumeDraftWorkHistory } from '@aramo/talent-extraction';

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
  // Reviewable, grounded work-history entries (governed_llm mode only; declared
  // 'from résumé', NOT verified). The recruiter edits these in the review card;
  // on create they persist as TalentWorkHistoryEntry (source='resume').
  work_history?: ResumeDraftWorkHistory[];
}
