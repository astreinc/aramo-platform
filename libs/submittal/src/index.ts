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
