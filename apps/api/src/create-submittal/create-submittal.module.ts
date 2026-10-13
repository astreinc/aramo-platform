import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { SubmittalModule } from '@aramo/submittal';

import { CreateSubmittalController } from './create-submittal.controller.js';
import { CreateSubmittalOrchestrator } from './create-submittal.service.js';

// SW-1 (Submittal Workspace, R1-A) — composition root for POST /v1/submittals.
// The create command moves here (apps/api) from libs/submittal so the Pipeline
// episode is derived server-side. Imports:
//   - PipelineModule  → PipelineRepository.findLiveEpisode (derivation authority)
//   - SubmittalModule → SubmittalRepository.createSubmittal (persistence authority)
//   - ConsentModule   → IdempotencyService (shared Idempotency-Key table)
//   - AuthModule      → JwtAuthGuard / AuthContext (+ RolesGuard metadata)
//   - RequisitionModule → RequisitionRepository.findByIdForActor (INC-1b: the
//     authoritative requisition read used for server-resolved site + actor
//     requisition-visibility BEFORE the create mutation; job_id IS the requisition
//     id — same read the examine path uses, no new cross-schema SQL).
// This is the ONLY place the two domains meet for create; neither lib imports the
// other (the Pipeline⊥ domain boundary is composed, not hard-linked).
@Module({
  imports: [
    AuthModule,
    ConsentModule,
    PipelineModule,
    RequisitionModule,
    SubmittalModule,
  ],
  controllers: [CreateSubmittalController],
  providers: [CreateSubmittalOrchestrator],
})
export class CreateSubmittalModule {}
