import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';

import { ExaminationRepository } from './examination.repository.js';
import { MatchListController } from './match-list.controller.js';
import { OverrideController } from './override.controller.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/examination module — M3 PR-1 entity foundation + M3 PR-6
// (TalentJobExaminationFull projection) + M3 PR-7 (Live List query) +
// M3 PR-8 (match-list HTTP endpoint) + M4 PR-5 (override-create endpoint).
//
// PR-7 §2 Ruling 2: extend libs/examination (no new lib). PR-7's
// findActiveReqLiveList verifies the requisition is active and tenant-scoped.
// T1-a retired the job_domain.Requisition mirror this used to read; the check
// now goes through the RequisitionStateReader port (requisition-state-reader.
// port.ts), whose ATS-backed adapter apps/api binds at the composition root, so
// examination no longer imports @aramo/job-domain at all (the CIP⊥ATS wall
// holds by construction — the port is a plain interface in this lib).
//
// PR-8 §4.3: AuthModule is added to imports so the new MatchListController
// can use class-level JwtAuthGuard. MatchListController is the first
// HTTP controller in libs/examination; it is registered here directly.
//
// M4 PR-5 §4.6: ConsentModule is imported so OverrideController can inject
// IdempotencyService (the same shared service M4 PR-3 submittal-create
// uses — second cross-module consumer of the same consent.IdempotencyKey
// table per Ruling 7). OverrideController is the second HTTP controller
// in libs/examination; it is registered here alongside MatchListController.
@Module({
  imports: [AuthModule, ConsentModule],
  controllers: [MatchListController, OverrideController],
  providers: [PrismaService, ExaminationRepository],
  exports: [ExaminationRepository],
})
export class ExaminationModule {}
