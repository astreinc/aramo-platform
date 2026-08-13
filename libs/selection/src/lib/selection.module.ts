import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';
import { ConsentModule } from '@aramo/consent';
import { ExaminationModule } from '@aramo/examination';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { SelectionController } from './selection.controller.js';
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
// SelectionController + wire DTOs remain in libs/selection and delegate
// to this module via @aramo/selection.
//
// This module registers exactly the domain graph the previous
// SelectionModule provided MINUS the HTTP-controller surface (which the
// facade retains): the three repositories, PrismaService, the two
// constructor-DI AramoLogger providers (Style A; token strings preserved —
// the repositories still @Inject('SelectionRepositoryLogger') /
// @Inject('SelectionEventRepositoryLogger')), and the DeliveryProvider
// port (SendStub). Domain-dependency imports: TalentRecordModule (Pattern-C
// create validator), RequisitionModule (Pattern-A validator), and
// ExaminationModule (Pattern-B validator). Auth/Consent/AiDraft imports
// belonged to the controller and now live in the selection facade module.
@Module({
  imports: [
    TalentRecordModule,
    RequisitionModule,
    ExaminationModule,
    AuthModule,
    ConsentModule,
    AiDraftModule,
  ],
  controllers: [SelectionController],
  providers: [
    PrismaService,
    SelectionRepository,
    SelectionEventRepository,
    SelectionOutboxRepository,
    {
      provide: 'SelectionRepositoryLogger',
      useFactory: () => createAramoLogger(SelectionRepository.name),
    },
    {
      provide: 'SelectionEventRepositoryLogger',
      useFactory: () => createAramoLogger(SelectionEventRepository.name),
    },
    {
      provide: 'SelectionControllerLogger',
      useFactory: () => createAramoLogger(SelectionController.name),
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
