export { ResumeParseModule } from './lib/resume-parse.module.js';
export { ResumeParserService } from './lib/resume-parser.service.js';
// The deterministic file→TEXT extractor (pdf-parse / mammoth, no-LLM) is
// exported so the résumé-text re-extract path + the governed draft orchestrator
// can reuse it against the retained S3 file. Résumé FACT extraction is
// governed-LLM-only (TI-1F P0.2) — this lib no longer extracts facts.
export { extractResumeText } from './lib/heuristics/text-extractor.js';
export type {
  ParseResumeInput,
  ParseStatus,
  TalentRecordPrefill,
} from './lib/types/parse-resume.types.js';
// HF1 §3 / R1 — the canonical résumé source-map. Built here (the bytes→text
// owner), passed BY VALUE through the controller into talent-extraction for
// ref-grounding; talent-extraction never imports this lib.
export {
  RESUME_SOURCE_MAP_VERSION,
  buildResumeSourceMap,
} from './lib/source-map.js';
export type { ResumeSourceMap, SourceMapBlock } from './lib/source-map.js';
