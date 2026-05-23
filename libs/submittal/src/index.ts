export { SubmittalModule } from './lib/submittal.module.js';
export { SubmittalRepository } from './lib/submittal.repository.js';
export { SubmittalController } from './lib/submittal.controller.js';
export { PrismaService } from './lib/prisma/prisma.service.js';

export type {
  CreateSubmittalInput,
  CreateSubmittalRequestDto,
  CreateSubmittalResponseDto,
  FailedCriterionAcknowledgment,
  SubmittalStateValue,
  TalentSubmittalRecordView,
} from './lib/dto/index.js';

// M4 PR-4 — confirm endpoint surfaces.
export {
  ConfirmSubmittalRequestDto,
  RecruiterAttestationsDto,
} from './lib/dto/index.js';
export type {
  ConfirmSubmittalResponseDto,
} from './lib/dto/index.js';
export type { ConfirmSubmittalInput } from './lib/submittal.repository.js';

// M4 PR-7 — revoke endpoint surfaces.
export { RevokeSubmittalRequestDto } from './lib/dto/index.js';
export type { RevokeSubmittalResponseDto } from './lib/dto/index.js';
export type { RevokeSubmittalInput } from './lib/submittal.repository.js';
