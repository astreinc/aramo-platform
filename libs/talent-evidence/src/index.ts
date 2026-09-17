export { TalentEvidenceModule } from './lib/talent-evidence.module.js';
export { TalentEvidenceRepository } from './lib/talent-evidence.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

// SKILL-TAX-1G — canonical reconciliation orchestrator (internal; no HTTP/scope).
export { TalentSkillCanonicalizationModule } from './lib/talent-skill-canonicalization.module.js';
export {
  TalentSkillCanonicalizationService,
  type ReconcileTalentResult,
} from './lib/talent-skill-canonicalization.service.js';
export {
  aggregateCanonicalYears,
  type CanonicalUsageRow,
  type CanonicalSkillYears,
} from './lib/canonical-skill-timeline.js';
export {
  TalentCanonicalCoverageRepository,
  type CanonicalCoverage,
} from './lib/talent-canonical-coverage.repository.js';
export type {
  // TalentSkillEvidence (Group 2 §2.2 #16)
  CreateTalentSkillEvidenceInput,
  TalentSkillEvidenceRow,
  TalentSkillEvidenceSourceValue,
  // TalentWorkHistoryEntry (Group 2 §2.2 #10)
  CreateTalentWorkHistoryEntryInput,
  TalentWorkHistoryEntryRow,
  TalentWorkHistorySourceValue,
  // TalentContactMethod (Group 2 §2.2 #4)
  CreateTalentContactMethodInput,
  TalentContactMethodRow,
  TalentContactTypeValue,
  TalentContactVerificationStatusValue,
  // TalentRateExpectation (Group 2 §2.2 #7)
  CreateTalentRateExpectationInput,
  TalentRateExpectationRow,
  TalentEmploymentTypeValue,
  TalentRatePeriodValue,
  TalentRateSourceValue,
  // TalentWorkAuthorization (Group 2 §2.2 #6 — Declared (Sensitive); F16)
  CreateTalentWorkAuthorizationInput,
  TalentWorkAuthorizationRow,
  TalentWorkAuthorizationStatusValue,
  // TalentDocument (Group 2 §2.2 #8)
  CreateTalentDocumentInput,
  TalentDocumentRow,
  TalentDocumentTypeValue,
  TalentDocumentParseStatusValue,
  TalentDocumentRetentionPolicyValue,
  // TalentResumeEdition / TalentResumeDefault (TALENT-INTEL-1 §5)
  CreateTalentResumeEditionInput,
  TalentResumeEditionRow,
  TalentResumeEditionPurposeValue,
  TalentResumeEditionLifecycleValue,
  SetTalentResumeDefaultInput,
  TalentResumeDefaultRow,
  // TalentDerivedSnapshot (Group 2 §2.2 #17)
  CreateTalentDerivedSnapshotInput,
  TalentDerivedSnapshotRow,
} from './lib/talent-evidence.repository.js';
