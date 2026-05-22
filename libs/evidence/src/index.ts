export { EvidenceModule } from './lib/evidence.module.js';
export { EvidenceRepository } from './lib/evidence.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  // PR-1 output (read-side) types
  CapabilitySummary,
  ContactSummary,
  ConversationSummary,
  MatchJustification,
  RecruiterContribution,
  TalentConfirmed,
  TalentIdentity,
  TalentJobEvidencePackageView,
  WorkHistoryExcerpt,
  // PR-2 input (write-side) types
  BuildPackageInput,
  CapabilitySummaryOverrides,
  MatchJustificationOverrides,
  RecruiterContributionInput,
  TalentConfirmedInput,
} from './lib/dto/talent-job-evidence-package.view.js';
