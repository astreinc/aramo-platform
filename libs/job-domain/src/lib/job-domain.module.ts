import { Module } from '@nestjs/common';

import { JobDomainRepository } from './job-domain.repository.js';
import { PrismaService } from './prisma/prisma.service.js';

// libs/job-domain module — M3 PR-4 minimal Job-domain entity foundation
// (directive §4). Wires the job-domain-owned PrismaService and the
// JobDomainRepository that creates / reads Job, GoldenProfile, and
// Requisition rows. The PR-1 entity-foundation pattern is followed
// verbatim.
//
// PR-4 adds no controllers, no HTTP endpoints, no Pact surface. Out of
// scope per directive §5: the full Group 3 Golden Profile (tasks, outcomes,
// team context, career value beyond the skills/experience/constraints
// anchors), any FK constraint, consumers (TalentJobExaminationFull /
// Live List / read endpoint), Talent-evidence sub-entities, and
// backfilling existing examination rows.
@Module({
  providers: [PrismaService, JobDomainRepository],
  exports: [JobDomainRepository],
})
export class JobDomainModule {}
