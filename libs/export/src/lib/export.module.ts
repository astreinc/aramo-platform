import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { ExportController } from './export.controller.js';
import { ExportService } from './export.service.js';

// ExportModule — PR-A8-4 Gate 5 — ATS-domain CSV export.
//
// === Leaf import set (lint:nx-boundaries) ===
//
// Reads-only over the 5 ATS-domain entities (the export catalog):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard, RequireScopes, RequireSiteMatch
//   - EntitlementModule   → EntitlementGuard, RequireCapability
//   - CompanyModule       → CompanyRepository.list
//   - ContactModule       → ContactRepository.list
//   - TalentRecordModule  → TalentRecordRepository.list
//   - RequisitionModule   → RequisitionRepository.listForActor (A3)
//   - PipelineModule      → PipelineRepository.list (filtered by
//                            upstream-resolved A3-visible requisition_ids)
//
// === The TWO load-bearing guards (the Lead-review surface) ===
//
// (1) R10 — STRUCTURAL seam-exclusion. This module imports ZERO
//     Core / engagement / submittal / examination / matching /
//     talent / job_domain modules. The dependency closure is the
//     proof: A8-4 reads no Core schema. The integration spec
//     replays the A7 reporting-service pattern by OMITTING every
//     Core migration from the test container and asserting the
//     export routes still serve 200 (if any Core read existed it
//     would 500 with `relation does not exist`). A CSV NEVER
//     contains a Core-judgment column — there is no Core read in
//     the engine, and the ATS-domain schemas structurally hold no
//     judgment field.
//
// (2) A3-visibility. Per Ruling 2: visibility is a query predicate,
//     not a guard rejection. Both `requisition:read` (recruiter)
//     and `requisition:read:all` (tenant_admin) pass @RequireScopes;
//     the rows EXPORTED differ. Recruiter sees own-assigned
//     requisitions (RequisitionRepository.listForActor) and only
//     pipelines on those visible requisitions (composed at the
//     export-service layer — pipeline.requisition_id is cross-
//     schema, so the visible-id list is resolved upstream and
//     passed to PipelineRepository.list as `requisition_ids`).
//     Reference-entity exports (company / contact / talent_record)
//     are tenant-wide for both roles — A3 is assignment-keyed and
//     A7 set the precedent that it doesn't apply to reference data.
//
// All entity-module edges are FORWARD (export → entity); no entity
// module imports @aramo/export → no cycle.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    CompanyModule,
    ContactModule,
    PipelineModule,
    RequisitionModule,
    TalentRecordModule,
  ],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
