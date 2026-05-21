export { ExaminationModule } from './lib/examination.module.js';
export { ExaminationRepository } from './lib/examination.repository.js';
export type {
  CreateExaminationSnapshotInput,
  TalentJobExaminationRow,
  MarkSupersededInput,
  // M3 PR-7 §4.1 — Live List query input.
  FindActiveReqLiveListInput,
  ExaminationTriggerValue,
  ExaminationTierValue,
  ExaminationLifecycleStateValue,
} from './lib/examination.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// M3 PR-6 — Reasoning + evidence linkage (TalentJobExaminationFull)
// typed projection. Project-only (§2 Ruling 2); read-only.
export {
  projectFullView,
  projectSummaryView,
} from './lib/examination-full.projection.js';
export type {
  // Fully-specified (Group 2 §2.4 byte-faithful)
  ExaminationReasoning,
  ExaminationReasoningCategory,
  EvidenceReference,
  EvidenceEntityTypeValue,
  RiskFlag,
  RiskFlagType,
  RiskFlagSeverity,
  ConfidenceIndicator,
  ConfidenceIndicators,
  ConfidenceLevel,
  DeltaToEntrustable,
  DeltaCurrentTier,
  DeltaNextTierTarget,
  // Named-only (PR-6-defined name-keyed projection shapes; Ruling 1)
  SkillMatchSummary,
  SkillMatchSummaryPerSkill,
  ExperienceMatchSummary,
  ConstraintCheckSummary,
  FreshnessIndicator,
  // Projected views (read boundary)
  TalentJobExaminationSummaryView,
  TalentJobExaminationFullView,
} from './lib/examination-full.types.js';
