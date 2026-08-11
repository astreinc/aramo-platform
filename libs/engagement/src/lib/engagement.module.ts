import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';
import { ConsentModule } from '@aramo/consent';
import { TalentRecordModule } from '@aramo/talent-record';
import { SelectionModule } from '@aramo/selection';

import { EngagementController } from './engagement.controller.js';

// libs/engagement — controller-only frozen facade (T2-P2).
//
// PO CONTROLLER-ONLY FACADE ruling (2026-08-10): the Selection domain
// (repositories, PrismaService, delivery port, state/event closed-lists,
// prisma `selection` schema + migrations) is canonical in @aramo/selection.
// This module retains ONLY the frozen EngagementController (the
// /v1/engagements HTTP surface + engagement:* wire contract, P3-deferred)
// and delegates every domain dependency to SelectionModule.
//
// Module-graph wiring (unchanged from the pre-split EngagementModule minus
// the domain-repository providers, which SelectionModule now owns):
//   - SelectionModule — provides SelectionRepository / SelectionEventRepository
//     (injected by the controller under their EngagementRepository /
//     EngagementEventRepository aliases), PrismaService, and the
//     DELIVERY_PROVIDER_TOKEN DeliveryProvider port.
//   - AuthModule — JwtAuthGuard class-level on the controller.
//   - ConsentModule — IdempotencyService (POST replay-or-conflict) +
//     ConsentService (consent-at-send binding gate).
//   - TalentRecordModule — TalentRecordRepository (record-supersession
//     send-gate, TR-2a-B3a).
//   - AiDraftModule — AiDraftService (outreach LLM drafts).
//
// RolesGuard + VisibilityInterceptor remain wired globally in apps/api
// (AuthorizationModule + APP_INTERCEPTOR); the facade needs neither.
// The repository Pattern-A/B/C validators' RequisitionModule /
// ExaminationModule imports moved with the repositories into SelectionModule.
//
// The 'EngagementControllerLogger' Style-A constructor-DI AramoLogger
// provider stays here with the controller it names.
@Module({
  imports: [SelectionModule, AuthModule, ConsentModule, TalentRecordModule, AiDraftModule],
  controllers: [EngagementController],
  providers: [
    {
      provide: 'EngagementControllerLogger',
      useFactory: () => createAramoLogger(EngagementController.name),
    },
  ],
})
export class EngagementModule {}
