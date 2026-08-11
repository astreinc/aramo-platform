import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { ExaminationModule } from '@aramo/examination';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { DELIVERY_PROVIDER_TOKEN } from './delivery/tokens.js';
import { SendStubDeliveryProvider } from './delivery/send-stub.provider.js';
import { SelectionRepository } from './selection.repository.js';
import { SelectionEventRepository } from './selection-event.repository.js';
import { SelectionOutboxRepository } from './selection-outbox.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/selection — canonical Selection domain module (T2-P2).
//
// PO CONTROLLER-ONLY FACADE ruling (2026-08-10): the Selection domain
// (repositories, PrismaService, state/event closed-lists, delivery port,
// prisma `selection` schema + migrations) is canonical here. The frozen
// EngagementController + wire DTOs remain in libs/engagement and delegate
// to this module via @aramo/selection.
//
// This module registers exactly the domain graph the previous
// EngagementModule provided MINUS the HTTP-controller surface (which the
// facade retains): the three repositories, PrismaService, the two
// constructor-DI AramoLogger providers (Style A; token strings preserved —
// the repositories still @Inject('EngagementRepositoryLogger') /
// @Inject('EngagementEventRepositoryLogger')), and the DeliveryProvider
// port (SendStub). Domain-dependency imports: TalentRecordModule (Pattern-C
// create validator), RequisitionModule (Pattern-A validator), and
// ExaminationModule (Pattern-B validator). Auth/Consent/AiDraft imports
// belonged to the controller and now live in the engagement facade module.
@Module({
  imports: [TalentRecordModule, RequisitionModule, ExaminationModule],
  providers: [
    PrismaService,
    SelectionRepository,
    SelectionEventRepository,
    SelectionOutboxRepository,
    {
      provide: 'EngagementRepositoryLogger',
      useFactory: () => createAramoLogger(SelectionRepository.name),
    },
    {
      provide: 'EngagementEventRepositoryLogger',
      useFactory: () => createAramoLogger(SelectionEventRepository.name),
    },
    { provide: DELIVERY_PROVIDER_TOKEN, useClass: SendStubDeliveryProvider },
  ],
  exports: [
    SelectionRepository,
    SelectionEventRepository,
    SelectionOutboxRepository,
    PrismaService,
    // The DeliveryProvider port the frozen controller injects via
    // @Inject(DELIVERY_PROVIDER_TOKEN). Export the TOKEN only — the
    // SendStubDeliveryProvider concrete is registered under the token
    // (useClass), not under its own class token, so it must not be listed
    // here (Nest can only export a provider registered by that exact token).
    DELIVERY_PROVIDER_TOKEN,
  ],
})
export class SelectionModule {}
