export { TalentRecordModule } from './lib/talent-record.module.js';
export { TalentRecordController } from './lib/talent-record.controller.js';
export { TalentRecordRepository } from './lib/talent-record.repository.js';
export { TalentLinkService } from './lib/talent-link.service.js';
export { PrismaService as TalentRecordPrismaService } from './lib/prisma/prisma.service.js';

// Search PR-2 — résumé full-text surfaces.
export { ResumeTextService } from './lib/resume-text/resume-text.service.js';
export type {
  EnqueueReindexInput,
  DrainResult,
} from './lib/resume-text/resume-text.service.js';
export { redactResumeText } from './lib/resume-text/redaction.js';
export { ResumeReindexModule } from './lib/resume-text/resume-reindex.module.js';
export { ResumeReindexProcessor } from './lib/resume-text/resume-reindex.processor.js';
export {
  RESUME_REINDEX_QUEUE_NAME,
  RESUME_REINDEX_BATCH_SIZE,
} from './lib/resume-text/resume-reindex.queue.constants.js';

export type {
  TalentRecordView,
  CreateTalentRecordRequestDto,
  UpdateTalentRecordRequestDto,
  TalentLinkView,
} from './lib/dto/index.js';
export { LinkTalentRecordRequestDto } from './lib/dto/link-talent-record-request.dto.js';
