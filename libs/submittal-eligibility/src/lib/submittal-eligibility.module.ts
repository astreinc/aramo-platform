import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { SubmittalPolicyRepository } from './submittal-policy.repository.js';
import { RequisitionSubmittalEligibilityReader } from './requisition-eligibility-reader.js';

// libs/submittal-eligibility module — Lane L8-B1. Owns the SubmittalEligibility
// truth: the policy aggregate + append-only policy-event history + the neutral
// pure eligibility port (submittal-eligibility.port.ts — no DI, imported directly).
//
// Policy-admin half only here (PrismaService + policy repository). The ATOMIC
// client-submittal command lives at the apps/api orchestration boundary
// (Approach A, §6) and imports the pure port + this repository's reads.
@Module({
  imports: [AuthModule],
  providers: [
    PrismaService,
    SubmittalPolicyRepository,
    RequisitionSubmittalEligibilityReader,
    {
      provide: 'SubmittalPolicyRepositoryLogger',
      useFactory: () => createAramoLogger(SubmittalPolicyRepository.name),
    },
  ],
  exports: [
    SubmittalPolicyRepository,
    RequisitionSubmittalEligibilityReader,
    PrismaService,
  ],
})
export class SubmittalEligibilityModule {}
