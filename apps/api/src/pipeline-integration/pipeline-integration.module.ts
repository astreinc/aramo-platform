import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { IntegrationModule } from '@aramo/integration';

import { PipelineProviderMappingAdminService } from './pipeline-provider-mapping-admin.service.js';
import { PipelineProviderMappingAdminController } from './pipeline-provider-mapping-admin.controller.js';
import { PipelineProviderObservationOrchestrator } from './pipeline-provider-observation.orchestrator.js';

// L2-I (D1) — the Pipeline provider-integration composition root (apps/api). This is the ONLY
// layer that may know BOTH the @aramo/integration mapping seam AND the governed @aramo/pipeline
// command (SB-7): it composes the author-time mapping-admin (canonical-target validation) and
// the inbound reconciler-analog (governed command OR pending, never mutate). Imports the two
// owner modules for their EXPORTED surfaces (PipelineRepository + the mapping/identity/
// reconciliation/provenance repos). No new schema, command, or ontology is authored here.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, PipelineModule, IntegrationModule],
  controllers: [PipelineProviderMappingAdminController],
  providers: [PipelineProviderMappingAdminService, PipelineProviderObservationOrchestrator],
  exports: [PipelineProviderMappingAdminService, PipelineProviderObservationOrchestrator],
})
export class PipelineIntegrationModule {}
