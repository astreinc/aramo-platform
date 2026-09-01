import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { ClientSelectionModule, ClientSelectionPrismaService } from '@aramo/client-selection';
import { PipelineModule } from '@aramo/pipeline';

import { ClientDecisionController } from './client-decision.controller.js';
import { ClientDecisionOrchestrator } from './client-decision.orchestrator.js';

// L3-E(2) — apps/api composition root for the governed client-decision → Pipeline
// disposition. Imports the owner ClientSelectionModule (the CAS'd transition + repo) and
// PipelineModule (the system-gated PipelineRepository). This module — NOT
// apps/api/src/client-selection — is the one client-selection-adjacent apps/api surface
// permitted to import @aramo/pipeline (it IS the governed disposition seam); the pure
// create/transition surfaces stay pipeline-free per the L3-A write-authority guard.
// 'ClientDecisionDb' is a lazy-DATABASE_URL connection used ONLY to read submittal.pipeline_id.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    ClientSelectionModule,
    PipelineModule,
  ],
  controllers: [ClientDecisionController],
  providers: [
    ClientDecisionOrchestrator,
    { provide: 'ClientDecisionDb', useClass: ClientSelectionPrismaService },
  ],
})
export class ClientDecisionOrchestrationModule {}
