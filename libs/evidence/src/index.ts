export { EvidenceModule } from './lib/evidence.module.js';
export { EvidenceRepository } from './lib/evidence.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  CapabilitySummary,
  ContactSummary,
  MatchJustification,
  RecruiterContribution,
  TalentConfirmed,
  TalentIdentity,
  TalentJobEvidencePackageView,
  WorkHistoryExcerpt,
} from './lib/dto/talent-job-evidence-package.view.js';
