import { Module } from '@nestjs/common';
import { JobDomainModule } from '@aramo/job-domain';

import { ExaminationRepository } from './examination.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/examination module — M3 PR-1 entity foundation + M3 PR-6
// (TalentJobExaminationFull projection) + M3 PR-7 (Live List query).
//
// PR-7 §2 Ruling 2: extend libs/examination (no new lib). PR-7's
// findActiveReqLiveList consumes JobDomainRepository.findRequisitionById to
// verify the requisition is active and tenant-scoped — JobDomainModule is
// imported here so ExaminationRepository can inject JobDomainRepository
// (consumer-side only; PR-7 adds no JobDomainRepository method).
//
// PR-1 adds no controllers, no HTTP endpoints, no Pact surface; PR-6 ships
// schemas + projection only; PR-7 ships the repository method + index only.
// Match-Mode policy, the HTTP endpoint, and the Summary/Full Pact split are
// PR-8's deliverable.
@Module({
  imports: [JobDomainModule],
  providers: [PrismaService, ExaminationRepository],
  exports: [ExaminationRepository],
})
export class ExaminationModule {}
