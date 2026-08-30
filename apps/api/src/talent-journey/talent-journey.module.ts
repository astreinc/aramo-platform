import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { ClientSelectionModule } from '@aramo/client-selection';
import { SubmittalModule } from '@aramo/submittal';

import { OfferModule } from '../offer/offer.module.js';
import { PlacementModule } from '../placement/placement.module.js';
import { PreStartRequirementModule } from '../pre-start-requirement/pre-start-requirement.module.js';

import { TalentJourneyController } from './talent-journey.controller.js';
import { TalentJourneyReadService } from './talent-journey-read.service.js';

// Lane 2 / L2-H — the Unified Talent Journey read-composer module (apps/api composition root:
// the ONLY layer allowed to know all owners). Imports every owner module for its EXPORTED read
// repository (Pipeline / Submittal / Client-Selection+Interview+JourneyProjection / Offer /
// Placement / Pre-Start), plus the guard modules for the A2 chain. Provides the composer + its
// logger; declares the GET-only journey controller. No owner write model, schema, or command is
// touched — this module reads only.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    PipelineModule,
    ClientSelectionModule,
    SubmittalModule,
    OfferModule,
    PlacementModule,
    PreStartRequirementModule,
  ],
  controllers: [TalentJourneyController],
  providers: [
    TalentJourneyReadService,
    {
      provide: 'TalentJourneyLogger',
      useFactory: () => createAramoLogger(TalentJourneyReadService.name),
    },
  ],
})
export class TalentJourneyModule {}
