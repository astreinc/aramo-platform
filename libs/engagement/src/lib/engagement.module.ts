import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { EngagementRepository } from './engagement.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/engagement module — M5 PR-1 entity foundation.
//
// PR-1 (substrate-only) registers PrismaService + the read-only
// EngagementRepository. Write paths (createEngagement, transitionState)
// land at M5 PR-3 (engagement-creation write path).
//
// EngagementModule is NOT imported by apps/api at PR-1 (substrate only;
// no HTTP route consumer). The engagement state-transition endpoint PR
// (M5 PR-4) will add the AppModule import alongside its controller.
//
// M4-close HK-PR-4 — Style A constructor-DI AramoLogger provider for
// EngagementRepository, keyed by the 'EngagementRepositoryLogger'
// token. Factory context is EngagementRepository.name. Style B field-
// factory pattern is in PrismaService directly (instantiated outside
// DI in testcontainer setup).
@Module({
  providers: [
    PrismaService,
    EngagementRepository,
    {
      provide: 'EngagementRepositoryLogger',
      useFactory: () => createAramoLogger(EngagementRepository.name),
    },
  ],
  exports: [EngagementRepository, PrismaService],
})
export class EngagementModule {}
