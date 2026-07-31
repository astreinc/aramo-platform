import { Module } from '@nestjs/common';
import { ActivityModule } from '@aramo/activity';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { RequisitionModule } from '@aramo/requisition';

import { PrismaService } from './prisma/prisma.service.js';
import { PipelineController } from './pipeline.controller.js';
import { PipelineRepository } from './pipeline.repository.js';
import {
  AddTalentPolicyService,
  REQUISITION_ADD_POLICY_PACKAGE,
} from './policy/add-talent-policy.service.js';
import { REQUISITION_LIFECYCLE_PACKAGE } from './policy/requisition-lifecycle.package.js';

// PipelineModule — PR-A5a Gate 5 ATS Batch 4a (the state machine).
//
// Leaf import set (lint:nx-boundaries — directional edges only):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//   - ActivityModule      → directional dependency (pipeline → activity).
//                           The actual in-tx Activity write goes through
//                           the @aramo/activity `insertActivityInTx`
//                           helper (cross-schema $executeRaw composed
//                           into the pipeline transition's $transaction);
//                           the module import is what makes the
//                           dependency edge visible to lint:nx-boundaries
//                           and the build graph.
//
// No back-edge: ActivityModule does NOT import PipelineModule
// (lint:nx-boundaries `import-x/no-cycle` enforces this; the
// pipeline → activity edge is intentionally one-way).
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, ActivityModule, RequisitionModule],
  controllers: [PipelineController],
  providers: [
    PrismaService,
    PipelineRepository,
    AddTalentPolicyService,
    { provide: REQUISITION_ADD_POLICY_PACKAGE, useValue: REQUISITION_LIFECYCLE_PACKAGE },
  ],
  exports: [PipelineRepository, AddTalentPolicyService],
})
export class PipelineModule {}
