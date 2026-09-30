// Enterprise Search GS-2A — talent-embedding lib public surface. Consumers depend on the ports +
// domain types; the concrete repository + PrismaService are exported for wiring/tests only.
export { TalentEmbeddingModule } from './lib/talent-embedding.module.js';
export { TalentEmbeddingRepository } from './lib/talent-embedding.repository.js';
export { PrismaService as TalentEmbeddingPrismaService } from './lib/prisma/prisma.service.js';

export {
  TALENT_EMBEDDING_STATUSES,
  TALENT_EMBEDDING_TRANSITIONS,
  canTalentEmbeddingTransition,
  type TalentEmbeddingStatus,
} from './lib/talent-embedding-status.js';

export {
  TALENT_EMBEDDING_REPOSITORY_PORT,
  type TalentEmbeddingRepositoryPort,
  type TalentEmbeddingWorkItem,
  type TalentEmbeddingDescriptor,
} from './lib/talent-embedding-repository.port.js';

export {
  TALENT_EMBEDDING_SEARCH_PORT,
  type TalentEmbeddingSearchPort,
  type TalentSemanticMatch,
} from './lib/talent-embedding-search.port.js';
