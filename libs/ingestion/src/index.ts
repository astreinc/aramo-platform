export { IngestionModule } from './lib/ingestion.module.js';
export { IngestionService } from './lib/ingestion.service.js';
export { IngestionRepository } from './lib/ingestion.repository.js';
export type {
  AcceptPayloadInput,
} from './lib/ingestion.service.js';
export type {
  CreateRawPayloadInput,
  RawPayloadRow,
} from './lib/ingestion.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
export {
  INGESTION_SOURCES,
  IngestionPayloadRequestDto,
} from './lib/dto/index.js';
export type {
  IngestionSource,
  IngestionStatus,
  DedupMatchSignal,
  DedupOutcomeDto,
  IngestionPayloadResponseDto,
} from './lib/dto/index.js';
