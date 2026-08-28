import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';

import { PrismaService } from './prisma/prisma.service.js';
import { RequisitionSubmittalEligibilityReader } from './requisition-eligibility-reader.js';

// libs/submittal-eligibility module — Lane L8-B1. Owns the SubmittalEligibility
// read surface: the requisition-grain Client Status reader + the neutral pure
// eligibility port (submittal-eligibility.port.ts — no DI, imported directly)
// + the serialized slot-consumption raw-SQL the apps/api orchestrator reuses.
@Module({
  imports: [AuthModule],
  providers: [PrismaService, RequisitionSubmittalEligibilityReader],
  exports: [RequisitionSubmittalEligibilityReader, PrismaService],
})
export class SubmittalEligibilityModule {}
