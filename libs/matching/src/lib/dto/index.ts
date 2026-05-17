export {
  MATCHING_ANALYSIS_INPUT_CONTRACT_VERSION,
  EXAMINATION_VERSION,
  MATCHING_MODEL_VERSION,
  TAXONOMY_VERSION,
} from './version-pins.js';

export {
  ROLE_FAMILIES,
  CONSTRAINT_CHECK_STATUSES,
  CONFIDENCE_LEVELS,
  RISK_SEVERITIES,
} from './matching-analysis-input.dto.js';

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
} from './matching-analysis-input.dto.js';
