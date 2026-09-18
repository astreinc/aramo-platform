// Public surface of @aramo/talent-extraction (Gate-1 G1-A).
//
// The declared-evidence production surface: read a talent's declared text
// (résumé body + key_skills, caller-supplied) → structure via the governed
// @aramo/ai-draft consumer surface → persist `declared` TalentSkillEvidence +
// TalentWorkHistoryEntry rows (constrained-to-source; no inference). The
// deterministic matching engine later consumes these evidence rows (G1-B); the
// LLM never participates in scoring.

export { TalentExtractionModule } from './lib/talent-extraction.module.js';
export { TalentExtractionService } from './lib/talent-extraction.service.js';
// TALENT-INTEL-1 TI-1D-C — re-export the résumé-edition ledger types so the ATS
// side (talent-record) names them through THIS sanctioned seam (which already
// depends on talent-evidence) instead of importing @aramo/talent-evidence directly
// (a scope:ats → scope:cip module-boundary edge). Type-only re-export.
export type {
  TalentResumeEditionRow,
  TalentResumeEditionWithDocumentRow,
} from '@aramo/talent-evidence';
export {
  deriveSkillId,
  normalizeSkillSurfaceForm,
  ARAMO_SKILL_NAMESPACE,
} from './lib/skill-id.js';

// TR-4 B2 — the pure ledger mapper (typed row → canonical CLAIMS payload).
export {
  mapWorkHistoryToClaim,
  mapSkillToClaim,
  mapAssertionToClaim,
  type LedgerClaim,
} from './lib/ledger-mapper.js';

export type {
  ExtractDeclaredEvidenceInput,
  ExtractDeclaredEvidenceResult,
  ExtractedSkill,
  ExtractedWorkHistory,
  ExtractionCompletion,
  // Add-Talent governed-LLM DRAFT extraction (HF1 durable fact extraction).
  ResumeDraftInput,
  ResumeDraftProposal,
  ResumeDraftResult,
  ResumeDraftStatus,
  ResumeDraftSkill,
  ResumeDraftWorkHistory,
  // HF2 v3 nested intelligence facts.
  ResumeDraftSkillUsage,
  ResumeDraftProject,
  ResumeDraftAssertion,
  ResumeDraftEducation,
  ResumeDraftCertification,
  GroundingClass,
  ResumeProvenance,
  ResumeSourceMap,
  SourceMapBlock,
  TalentWorkHistoryView,
} from './lib/dto/extraction.dto.js';
