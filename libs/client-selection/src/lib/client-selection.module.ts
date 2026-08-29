import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';

import { PrismaService } from './prisma/prisma.service.js';
import { ClientSelectionProcessRepository } from './client-selection.repository.js';
import { InterviewSessionRepository } from './interview-session.repository.js';
import { JourneyProjectionRepository } from './journey-projection.repository.js';
import { ClientSelectionController } from './client-selection.controller.js';

// Lane 2 / L2-F (F1 + F2) — the Client-Selection owner module. Import set
// (lint:nx-boundaries — directional edges only): Auth (JwtAuthGuard), Authorization
// (RolesGuard), Entitlement (EntitlementGuard), and (F2) Consent for IdempotencyService
// (the pipeline precedent; scope:ats → scope:boundary, nx-legal; consent does NOT import
// this lib so no cycle). No Pipeline import edge — Pipeline must never write this owner
// (I15/SB-7).
@Module({
  imports: [AuthModule, AuthorizationModule, ConsentModule, EntitlementModule],
  controllers: [ClientSelectionController],
  providers: [
    PrismaService,
    ClientSelectionProcessRepository,
    InterviewSessionRepository,
    JourneyProjectionRepository,
  ],
  // PrismaService is exported so the apps/api create-from-submittal orchestration can
  // bind it (useExisting) as its raw cross-schema read connection — the same singleton
  // the repositories write through (mirrors SubmittalEligibilityModule exporting its
  // PrismaService for SubmitTalentToClientService).
  exports: [
    ClientSelectionProcessRepository,
    InterviewSessionRepository,
    JourneyProjectionRepository,
    PrismaService,
  ],
})
export class ClientSelectionModule {}
