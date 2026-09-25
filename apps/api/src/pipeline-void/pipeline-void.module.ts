import { Module } from '@nestjs/common';
import { createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { CommunicationsModule } from '@aramo/communications';
import { SubmittalModule } from '@aramo/submittal';

import { OfferModule } from '../offer/offer.module.js';
import { PlacementModule } from '../placement/placement.module.js';

import { PipelineVoidController } from './pipeline-void.controller.js';
import { PipelineVoidService } from './pipeline-void.service.js';

// Accidental-Add Correction — the VOID orchestrator module (apps/api composition root: the
// only layer that may compose the pipeline command WITH the cross-domain engagement +
// downstream guards, ADR-0029 wall). Imports every owner module for its EXPORTED repository
// (Pipeline / Communications / Submittal / Offer / Placement) + the guard modules for the A2
// chain. Declares the GET-only... no — the POST /v1/pipelines/:id/void correction surface.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    PipelineModule,
    CommunicationsModule,
    SubmittalModule,
    OfferModule,
    PlacementModule,
  ],
  controllers: [PipelineVoidController],
  providers: [
    PipelineVoidService,
    {
      provide: 'PipelineVoidLogger',
      useFactory: () => createAramoLogger(PipelineVoidService.name),
    },
  ],
})
export class PipelineVoidModule {}
