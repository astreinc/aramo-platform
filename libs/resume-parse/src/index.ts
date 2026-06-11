export { ResumeParseModule } from './lib/resume-parse.module.js';
export { ResumeParserService } from './lib/resume-parser.service.js';
// Search PR-2 — additive reuse: the deterministic text extractor (pdf-parse /
// mammoth, no-LLM) is exported so the résumé-text re-extract path can reuse it
// against the retained S3 file. The E2 parse service (parseFromStorageKey) is
// UNCHANGED — this only widens the barrel.
export { extractResumeText } from './lib/heuristics/text-extractor.js';
export type {
  ParseResumeInput,
  ParseResumeResult,
  ParseStatus,
  TalentRecordPrefill,
} from './lib/types/parse-resume.types.js';
