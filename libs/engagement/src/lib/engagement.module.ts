import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';

import { EngagementRepository } from './engagement.repository.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/engagement module — M5 PR-1 entity foundation + M5 PR-2 event log.
//
// PR-1 (substrate-only) registers PrismaService + the read-only
// EngagementRepository. PR-2 extends with EngagementEventRepository
// (append-only event log). Write paths for TalentJobEngagement
// (createEngagement, transitionState) land at M5 PR-3.
//
// EngagementModule is consumed by libs/evidence at M5 PR-2 (cross-
// schema validator at EvidenceRepository.buildPackage references
// EngagementEventRepository.findByTenantAndId for each
// engagement_event_refs entry). Not imported by apps/api at PR-2
// (substrate only — no HTTP route consumer). The engagement state-
// transition endpoint PR (M5 PR-4) will add the AppModule import
// alongside its controller.
//
// M4-close HK-PR-4 — Style A constructor-DI AramoLogger providers for
// both repositories, keyed by 'EngagementRepositoryLogger' and
// 'EngagementEventRepositoryLogger'. Factory contexts are the class
// names. Style B field-factory pattern is in PrismaService directly
// (instantiated outside DI in testcontainer setup).
@Module({
  providers: [
    PrismaService,
    EngagementRepository,
    EngagementEventRepository,
    {
      provide: 'EngagementRepositoryLogger',
      useFactory: () => createAramoLogger(EngagementRepository.name),
    },
    {
      provide: 'EngagementEventRepositoryLogger',
      useFactory: () => createAramoLogger(EngagementEventRepository.name),
    },
  ],
  exports: [EngagementRepository, EngagementEventRepository, PrismaService],
})
export class EngagementModule {}
