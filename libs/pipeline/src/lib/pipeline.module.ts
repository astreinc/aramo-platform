import { Module } from '@nestjs/common';
import { ActivityModule } from '@aramo/activity';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { RequisitionModule } from '@aramo/requisition';
import { ConsentModule } from '@aramo/consent';
import { PolicyStore, PrismaService as PolicyStorePrismaService } from '@aramo/policy-store';

import { PrismaService } from './prisma/prisma.service.js';
import { PipelineController } from './pipeline.controller.js';
import { PipelineRepository } from './pipeline.repository.js';
import { AddTalentPolicyService } from './policy/add-talent-policy.service.js';

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
// L2-B — the ConsentModule edge provides IdempotencyService (the shared
// idempotency-key table lives in the consent schema; libs/selection +
// libs/submittal already consume it the same way). POST /v1/pipelines is now
// idempotency-gated, so pipeline gains a one-way edge to consent. No back-edge:
// ConsentModule does NOT import PipelineModule.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    ActivityModule,
    RequisitionModule,
    ConsentModule,
  ],
  controllers: [PipelineController],
  providers: [
    PrismaService,
    PipelineRepository,
    AddTalentPolicyService,
    // ADR-0024 PR-4a — runtime policy retrieval. PolicyStore (reading the
    // policy_store schema through its own PrismaService) replaces the deleted
    // in-code package DI token; the package is now published DATA, retrieved
    // per tenant at decision time.
    PolicyStorePrismaService,
    PolicyStore,
  ],
  exports: [PipelineRepository, AddTalentPolicyService],
})
export class PipelineModule {}
