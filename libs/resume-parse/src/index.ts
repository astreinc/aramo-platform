export { ResumeParseModule } from './lib/resume-parse.module.js';
export { ResumeParserService } from './lib/resume-parser.service.js';
// Search PR-2 — additive reuse: the deterministic text extractor (pdf-parse /
// mammoth, no-LLM) is exported so the résumé-text re-extract path can reuse it
// against the retained S3 file. The E2 parse service (parseFromStorageKey) is
// UNCHANGED — this only widens the barrel.
export { extractResumeText } from './lib/heuristics/text-extractor.js';
// HF2 R17 — the LOCAL, deterministic contact + location extractor (email /
// phone / city / state / ZIP). Reused by the governed-LLM draft path so contact
// is local (never model-derived), while the model input is separately redacted.
export { extractContact } from './lib/heuristics/field-extractor.js';
export type { ResumeContactFields } from './lib/heuristics/field-extractor.js';
export type {
  ParseResumeInput,
  ParseResumeResult,
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
