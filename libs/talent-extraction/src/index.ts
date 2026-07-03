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
export {
  deriveSkillId,
  normalizeSkillSurfaceForm,
  ARAMO_SKILL_NAMESPACE,
} from './lib/skill-id.js';

export type {
  ExtractDeclaredEvidenceInput,
  ExtractDeclaredEvidenceResult,
  ExtractedSkill,
  ExtractedWorkHistory,
  ExtractionCompletion,
} from './lib/dto/extraction.dto.js';
