export { MatchingModule } from './lib/matching.module.js';
export { MatchingService } from './lib/matching.service.js';
export { MatchingProcessor } from './lib/matching.processor.js';
export { MATCH_QUEUE_NAME } from './lib/match-queue.constants.js';
// PR-11 §4.1 — RedisConnectionConfig moved to @aramo/common for cross-lib reuse.
// Consumers must import from '@aramo/common' going forward; the libs/matching
// re-export was removed when the source file moved. ADR-0018 Decision 2.
export {
  evaluateEntrustability,
  EVIDENCE_THRESHOLDS,
} from './lib/engine.js';
export type {
  FailedCriterion,
  EntrustabilityExamination,
} from './lib/engine.js';
export {
  MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION,
  EXAMINATION_VERSION,
  MATCHING_MODEL_VERSION,
  TAXONOMY_VERSION,
  ROLE_FAMILIES,
  CONSTRAINT_CHECK_STATUSES,
  CONFIDENCE_LEVELS,
  RISK_SEVERITIES,
} from './lib/dto/index.js';
export type {
  RoleFamily,
  ConstraintCheckStatus,
  ConfidenceLevel,
  RiskSeverity,
  CriticalSkillExamination,
  ConstraintChecksEvaluated,
  ConfidenceIndicatorsEvaluated,
  RiskFlagEvaluated,
  BlockingConditions,
  MatchingAnalysisInput,
} from './lib/dto/index.js';
