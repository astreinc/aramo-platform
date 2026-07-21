import { Module } from '@nestjs/common';

import { IndeedJobSyncConnector } from './indeed/indeed-job-sync.connector.js';
import { IndeedTokenService } from './indeed/indeed-token.service.js';
import { JobDistributionPostingStateRepository } from './job-distribution-posting-state.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// SRC-2 PR-3 — the job-distribution lib module: wires this lib's own leaf
// providers (PrismaService over the job_distribution schema, the posting-state
// repository, the OAuth token service, the GraphQL connector). It imports ONLY
// @nestjs/common — NO @aramo edge, so the lib stays buildable-import-free. The
// sweep ORCHESTRATION + @Processor live in apps/api (per the PRIMARY ruling +
// the match-sweep precedent); apps/api imports this module to obtain the
// primitives and injects RequisitionRepository alongside them.
@Module({
  providers: [
    PrismaService,
    JobDistributionPostingStateRepository,
    IndeedTokenService,
    IndeedJobSyncConnector,
  ],
  exports: [
    JobDistributionPostingStateRepository,
    IndeedTokenService,
    IndeedJobSyncConnector,
  ],
})
export class JobDistributionModule {}
