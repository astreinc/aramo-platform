import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { ClientSelectionModule } from '@aramo/client-selection';
import { SubmittalModule } from '@aramo/submittal';
import { SubmittalEligibilityModule } from '@aramo/submittal-eligibility';
import { RequisitionModule } from '@aramo/requisition';

import { OfferModule } from '../offer/offer.module.js';
import { PlacementModule } from '../placement/placement.module.js';
import { DocumentReadinessModule } from '../rtr/document-readiness.module.js';

import { RequisitionTalentBoardController } from './requisition-talent-board.controller.js';
import { RequisitionTalentBoardReadService } from './requisition-talent-board-read.service.js';

// Requisition Talent Board (TB-1) — the Board read-composer module (apps/api composition
// root: the ONLY layer allowed to compose all scope:ats owners). Imports every owner module
// for its EXPORTED read repository (Pipeline / Submittal / Client-Selection / Offer /
// Placement / requisition submittal-eligibility reader / requisition-assignment), plus the
// guard modules for the A2 chain. Provides the composer + its logger; declares the GET-only
// Board controller. No owner write model, schema, or command is touched — this module reads
// only, and composes STATE ENUMS ONLY (no compensation/bill field).
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    PipelineModule,
    SubmittalModule,
    ClientSelectionModule,
    OfferModule,
    PlacementModule,
    SubmittalEligibilityModule,
    RequisitionModule,
    DocumentReadinessModule,
  ],
  controllers: [RequisitionTalentBoardController],
  providers: [
    RequisitionTalentBoardReadService,
    {
      provide: 'RequisitionTalentBoardLogger',
      useFactory: () => createAramoLogger(RequisitionTalentBoardReadService.name),
    },
  ],
})
export class RequisitionTalentBoardModule {}
