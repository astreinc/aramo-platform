import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { JobDomainModule } from '@aramo/job-domain';

import { PrismaService } from './prisma/prisma.service.js';
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
  ],
  controllers: [RequisitionController],
  providers: [
    PrismaService,
    RequisitionRepository,
    RequisitionAssignmentRepository,
    RequisitionProfileService,
    RequisitionIntakeService,
  ],
  exports: [RequisitionRepository, RequisitionAssignmentRepository],
})
export class RequisitionModule {}
