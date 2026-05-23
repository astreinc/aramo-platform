import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { JobDomainModule } from '@aramo/job-domain';

import { ExaminationRepository } from './examination.repository.js';
import { MatchListController } from './match-list.controller.js';
import { OverrideController } from './override.controller.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/examination module — M3 PR-1 entity foundation + M3 PR-6
// (TalentJobExaminationFull projection) + M3 PR-7 (Live List query) +
// M3 PR-8 (match-list HTTP endpoint) + M4 PR-5 (override-create endpoint).
//
// PR-7 §2 Ruling 2: extend libs/examination (no new lib). PR-7's
// findActiveReqLiveList consumes JobDomainRepository.findRequisitionById to
// verify the requisition is active and tenant-scoped — JobDomainModule is
// imported here so ExaminationRepository can inject JobDomainRepository
// (consumer-side; PR-7 added no JobDomainRepository method, PR-8 adds
// findActiveRequisitionByJobId for the controller's job_id → req_id bridge).
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
  imports: [AuthModule, ConsentModule, JobDomainModule],
  controllers: [MatchListController, OverrideController],
  providers: [PrismaService, ExaminationRepository],
  exports: [ExaminationRepository],
})
export class ExaminationModule {}
