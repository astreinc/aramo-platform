import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { JobDomainModule } from '@aramo/job-domain';
import { PlacementCapacityModule } from '@aramo/placement';
import {
  PolicyStore,
  PrismaService as PolicyStorePrismaService,
} from '@aramo/policy-store';

import { PrismaService } from './prisma/prisma.service.js';
import { SetPriorityPolicyService } from './policy/set-priority-policy.service.js';
import { RequisitionTransitionPolicyService } from './policy/requisition-transition-policy.service.js';
import { RequisitionAssignmentRepository } from './requisition-assignment.repository.js';
import { RequisitionController } from './requisition.controller.js';
import { RequisitionIntakeService } from './requisition-intake.service.js';
import { RequisitionProfileService } from './requisition-profile.service.js';
import { RequisitionRepository } from './requisition.repository.js';

// RequisitionModule — PR-A3 Gate 5 ATS Batch 2.
//
// Leaf import set (lint:nx-boundaries — no domain back-edges):
//   - AuthModule          → JwtAuthGuard
//   - AuthorizationModule → RolesGuard
//   - EntitlementModule   → EntitlementGuard
//
// No imports of @aramo/company or @aramo/contact. The cross-schema
// references (company_id, contact_id, company_department_id, recruiter_id,
// owner_id) are UUID-only logical references per Architecture §7.3 and
// are NOT validated at the application layer at this batch (referential
// integrity for company_id is the create-caller's responsibility for now;
// later batches may add tenant-scoped validation if needed).
@Module({
  // Job-Module LB-3 — AiDraftModule (the 2nd declared ai-draft consumer,
  // ADR-0015 v1.2) + JobDomainModule (the seam mint: Job + GoldenProfile).
  // Both are leaf/terminal w.r.t. requisition (no back-edge to requisition);
  // lint:nx-boundaries stays green (the dep graph is acyclic).
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    AiDraftModule,
    JobDomainModule,
    // Track 4 / T4-B1 — PULL the placement-owned capacity projection (§4). Leaf
    // w.r.t. requisition: placement has NO edge back (verified zero-outgoing),
    // so lint:nx-boundaries stays acyclic. Read-only exposure; nothing removed.
    PlacementCapacityModule,
  ],
  controllers: [RequisitionController],
  providers: [
    PrismaService,
    // ADR-0024 PR-7 — the SET_PRIORITY policy gate (R1, repository floor). The
    // policy-store PrismaService is its OWN generated client (lazy DATABASE_URL),
    // distinct from the requisition client above.
    PolicyStorePrismaService,
    PolicyStore,
    SetPriorityPolicyService,
    // T1-e — the governed-transition policy gate (§2.2), wired at the same
    // repository floor as SET_PRIORITY. Shares the PolicyStore provider above.
    RequisitionTransitionPolicyService,
    RequisitionRepository,
    RequisitionAssignmentRepository,
    RequisitionProfileService,
    RequisitionIntakeService,
  ],
  exports: [RequisitionRepository, RequisitionAssignmentRepository],
})
export class RequisitionModule {}
