import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { TalentRecordModule } from '@aramo/talent-record';
import { RequisitionModule } from '@aramo/requisition';
import { CompanyModule } from '@aramo/company';

import { OfferModule } from '../offer/offer.module.js';
import { PlacementModule } from '../placement/placement.module.js';

import { OfferStartWorklistController } from './offer-start-worklist.controller.js';
import { OfferStartWorklistReadService } from './offer-start-worklist-read.service.js';

// Offer & Start §9 — the cross-requisition Offer & Start worklist module (apps/api composition
// root). Imports each owner module for its EXPORTED read repository (Offer / Placement / Pipeline /
// Talent / Requisition / Company), plus the guard modules for the A2 chain. Provides the composer +
// its logger; declares the GET-only worklist controller. READ-ONLY: no owner write model, schema,
// or command is touched; the module persists nothing and owns no lifecycle.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    OfferModule,
    PlacementModule,
    PipelineModule,
    TalentRecordModule,
    RequisitionModule,
    CompanyModule,
  ],
  controllers: [OfferStartWorklistController],
  providers: [
    OfferStartWorklistReadService,
    {
      provide: 'OfferStartWorklistLogger',
      useFactory: () => createAramoLogger(OfferStartWorklistReadService.name),
    },
  ],
})
export class OfferStartWorklistModule {}
