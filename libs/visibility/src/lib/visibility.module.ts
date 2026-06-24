import { Module } from '@nestjs/common';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';
import { IdentityCoreModule } from '@aramo/identity';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';

import { VisibilityInterceptor } from './visibility.interceptor.js';
import { VisibilityResolverService } from './visibility-resolver.service.js';

// AUTHZ-D4b — VisibilityModule.
//
// Terminal lib (Gate-5 Ruling 1): depends on identity + company (the 3
// families per Amendment §4.3) + requisition + pipeline (the derived
// sets for the cascade). NOTHING on the entity side imports this module —
// the 6 entity repos receive VisibilityContext as a parameter passed
// down from controllers, so the cycle company → authorization → company
// concern doesn't recur.
//
// Imports of the entity modules here are NECESSARY for the resolver's
// derived-set computation (visible_requisition_ids consumed by pipeline
// + submittal + activity; visible_pipeline_ids consumed by activity's
// polymorphic OR). The reverse edges do not exist — verified by
// lint:nx-boundaries on import-x/no-cycle.
@Module({
  imports: [
    IdentityCoreModule,
    CompanyModule,
    RequisitionModule,
    PipelineModule,
    // Tasks backend — ContactModule supplies ContactRepository for
    // resolveVisibleContactIds (the 4th owner_type). Directional edge
    // (visibility → contact); contact does NOT import visibility (it takes
    // VisibilityContextShape from @aramo/common) — no cycle.
    ContactModule,
  ],
  providers: [VisibilityResolverService, VisibilityInterceptor],
  exports: [VisibilityResolverService, VisibilityInterceptor],
})
export class VisibilityModule {}
