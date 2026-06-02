export { TalentRecordModule } from './lib/talent-record.module.js';
export { TalentRecordController } from './lib/talent-record.controller.js';
export { TalentRecordRepository } from './lib/talent-record.repository.js';
export { PrismaService as TalentRecordPrismaService } from './lib/prisma/prisma.service.js';

export type {
  TalentRecordView,
  CreateTalentRecordRequestDto,
  UpdateTalentRecordRequestDto,
} from './lib/dto/index.js';
