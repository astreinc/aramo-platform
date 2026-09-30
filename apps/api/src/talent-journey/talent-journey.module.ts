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
  // Exported so the Talent 360 read-composition (apps/api/src/talent-360) can
  // reuse the authoritative per-episode journey composer for inline opportunity
  // expansion — one owner-attributed, GET-only journey per active episode. The
  // Talent 360 module imports TalentJourneyModule rather than re-deriving any
  // downstream stage (directive §3.4 / §4).
  exports: [TalentJourneyReadService],
})
export class TalentJourneyModule {}
