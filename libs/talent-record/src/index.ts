export { TalentRecordModule } from './lib/talent-record.module.js';
export { TalentRecordController } from './lib/talent-record.controller.js';
export { TalentRecordRepository } from './lib/talent-record.repository.js';
export { TalentLinkService } from './lib/talent-link.service.js';
export { PrismaService as TalentRecordPrismaService } from './lib/prisma/prisma.service.js';

export type {
  TalentRecordView,
  CreateTalentRecordRequestDto,
  UpdateTalentRecordRequestDto,
  TalentLinkView,
} from './lib/dto/index.js';
export { LinkTalentRecordRequestDto } from './lib/dto/link-talent-record-request.dto.js';
