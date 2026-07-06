export { IngestionModule } from './lib/ingestion.module.js';
export { IngestionService } from './lib/ingestion.service.js';
export { IngestionRepository } from './lib/ingestion.repository.js';
export type {
  AcceptPayloadInput,
} from './lib/ingestion.service.js';
export type {
  CreateRawPayloadInput,
  RawPayloadRow,
  ArrivalNeedingExtraction,
} from './lib/ingestion.repository.js';
export { PrismaService } from './lib/prisma/prisma.service.js';
// TR-2a-B1 (DDR-1 §3.1/§4) — the server-derived channel-source_class map.
export { deriveSourceClass } from './lib/source-class.map.js';
export type { IngestionSourceClass } from './lib/source-class.map.js';
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
