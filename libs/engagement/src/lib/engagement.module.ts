import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { ExaminationModule } from '@aramo/examination';
import { JobDomainModule } from '@aramo/job-domain';
import { TalentModule } from '@aramo/talent';

import { EngagementRepository } from './engagement.repository.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/engagement module — M5 PR-1 entity foundation + M5 PR-2 event log
// + M5 PR-3 write paths (createEngagement + transitionState).
//
// PR-1 (substrate-only) registered PrismaService + the read-only
// EngagementRepository. PR-2 extended with EngagementEventRepository
// (append-only event log). PR-3 extends EngagementRepository with
// createEngagement + transitionState write methods, which require three
// cross-schema validator deps imported here:
//   - TalentModule — Pattern C (overlay-existence proxy for tenant
//     visibility; TalentDto is tenant-agnostic by design per Talent
//     Record Spec §2.2).
//   - JobDomainModule — Pattern A (findRequisitionById + app-layer
//     tenant check on RequisitionRow.tenant_id).
//   - ExaminationModule — Pattern B (findById + app-layer tenant check
//     on TalentJobExaminationRow.tenant_id; nullable input).
//
// EngagementModule is consumed by libs/evidence at M5 PR-2 (cross-
// schema validator at EvidenceRepository.buildPackage). Not imported by
// apps/api at M5 PR-3 (substrate-only — no HTTP route consumer). The
// engagement state-transition endpoint PR (M5 PR-4) will add the
// AppModule import alongside its controller.
//
// M4-close HK-PR-4 — Style A constructor-DI AramoLogger providers for
// both repositories, keyed by 'EngagementRepositoryLogger' and
// 'EngagementEventRepositoryLogger'. Factory contexts are the class
// names. Style B field-factory pattern is in PrismaService directly
// (instantiated outside DI in testcontainer setup).
@Module({
  imports: [TalentModule, JobDomainModule, ExaminationModule],
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
