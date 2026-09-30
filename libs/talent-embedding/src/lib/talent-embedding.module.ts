import { Module } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentEmbeddingRepository } from './talent-embedding.repository.js';
import { TALENT_EMBEDDING_REPOSITORY_PORT } from './talent-embedding-repository.port.js';
import { TALENT_EMBEDDING_SEARCH_PORT } from './talent-embedding-search.port.js';

// Enterprise Search GS-2A — the talent-embedding module. Owns the talent_embedding PrismaService +
// the concrete pgvector repository, exposed behind two string-token ports: the lifecycle write port
// (consumed by the apps/api embedding worker) and the semantic read port (consumed by the GS-1
// Talent search adapter). One repository instance backs both tokens (useExisting).
@Module({
  providers: [
    PrismaService,
    TalentEmbeddingRepository,
    { provide: TALENT_EMBEDDING_REPOSITORY_PORT, useExisting: TalentEmbeddingRepository },
    { provide: TALENT_EMBEDDING_SEARCH_PORT, useExisting: TalentEmbeddingRepository },
  ],
  // PrismaService is exported (aliased TalentEmbeddingPrismaService via the barrel) so the apps/api
  // reconcile sweep can run its cross-schema anti-join on this connection.
  exports: [TALENT_EMBEDDING_REPOSITORY_PORT, TALENT_EMBEDDING_SEARCH_PORT, PrismaService],
})
export class TalentEmbeddingModule {}
