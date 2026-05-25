import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';
import { ConsentModule } from '@aramo/consent';
import { ExaminationModule } from '@aramo/examination';
import { JobDomainModule } from '@aramo/job-domain';
import { TalentModule } from '@aramo/talent';

import { DELIVERY_PROVIDER_TOKEN } from './delivery/tokens.js';
import { SendStubDeliveryProvider } from './delivery/send-stub.provider.js';
import { EngagementController } from './engagement.controller.js';
import { EngagementRepository } from './engagement.repository.js';
import { EngagementEventRepository } from './engagement-event.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/engagement module — M5 PR-1 entity foundation + M5 PR-2 event log
// + M5 PR-3 write paths + M5 PR-4 HTTP surface.
//
// PR-1 (substrate-only) registered PrismaService + the read-only
// EngagementRepository. PR-2 extended with EngagementEventRepository.
// PR-3 extended EngagementRepository with createEngagement +
// transitionState write methods (cross-schema validators).
//
// PR-4 adds the first HTTP-bearing surface: EngagementController with
// 4 endpoints (POST create, POST transition, GET engagement, GET
// events). New module imports required by the controller:
//   - AuthModule — JwtAuthGuard class-level on the controller.
//   - ConsentModule — IdempotencyService for POST endpoints
//     (replay-or-conflict-or-proceed pattern; M4 PR-3 precedent).
//
// EngagementModule is consumed by libs/evidence at M5 PR-2 (cross-
// schema validator at EvidenceRepository.buildPackage). At M5 PR-4 it
// is ALSO imported by apps/api's AppModule for HTTP route wiring.
//
// M4-close HK-PR-4 — Style A constructor-DI AramoLogger providers for
// both repositories AND the controller, keyed by their respective
// 'XRepositoryLogger' / 'EngagementControllerLogger' tokens. Factory
// contexts are the class names. Style B field-factory pattern is in
// PrismaService directly (instantiated outside DI in testcontainer
// setup).
// M5 PR-6 adds the second HTTP-bearing endpoint set (outreach send) +
// the DeliveryProvider port. New module-graph wiring:
//   - AiDraftModule import — AiDraftService is the LLM-draft entry per
//     ADR-0015; required by EngagementController.sendOutreach.
//   - DELIVERY_PROVIDER_TOKEN provider — SendStubDeliveryProvider at
//     PR-6 (Ruling 3 Q7-Stub). Mirrors the libs/ai-draft DRAFT_PROVIDER
//     wiring pattern.
@Module({
  imports: [
    AuthModule,
    ConsentModule,
    TalentModule,
    JobDomainModule,
    ExaminationModule,
    AiDraftModule,
  ],
  controllers: [EngagementController],
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
    {
      provide: 'EngagementControllerLogger',
      useFactory: () => createAramoLogger(EngagementController.name),
    },
    { provide: DELIVERY_PROVIDER_TOKEN, useClass: SendStubDeliveryProvider },
  ],
  exports: [EngagementRepository, EngagementEventRepository, PrismaService],
})
export class EngagementModule {}
