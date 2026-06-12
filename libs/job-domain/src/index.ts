export { JobDomainModule } from './lib/job-domain.module.js';
export { JobDomainRepository } from './lib/job-domain.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export type {
  CreateJobInput,
  JobRow,
  CreateGoldenProfileInput,
  GoldenProfileRow,
  CreateRequisitionInput,
  RequisitionRow,
  RequisitionStateValue,
} from './lib/job-domain.repository.js';
// Job-Module (Part 2 / R4) — the typed, matching-aligned GoldenProfile
// content shape + the storage projection helpers.
export type {
  GoldenProfileContent,
  GoldenProfileSkill,
  GoldenProfileExperience,
  GoldenProfileConstraints,
  GoldenProfileProvenance,
  GoldenProfileStorage,
} from './lib/dto/golden-profile-content.dto.js';
export {
  goldenProfileContentToStorage,
  goldenProfileContentFromStorage,
} from './lib/dto/golden-profile-content.dto.js';
