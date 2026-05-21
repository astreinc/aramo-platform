import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { JobDomainModule } from '@aramo/job-domain';

import { ExaminationRepository } from './examination.repository.js';
import { MatchListController } from './match-list.controller.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/examination module — M3 PR-1 entity foundation + M3 PR-6
// (TalentJobExaminationFull projection) + M3 PR-7 (Live List query) +
// M3 PR-8 (match-list HTTP endpoint).
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
@Module({
  imports: [AuthModule, JobDomainModule],
  controllers: [MatchListController],
  providers: [PrismaService, ExaminationRepository],
  exports: [ExaminationRepository],
})
export class ExaminationModule {}
