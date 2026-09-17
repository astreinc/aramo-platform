import { Module } from '@nestjs/common';
import { JobDomainModule } from '@aramo/job-domain';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';

import { PrismaService } from './prisma/prisma.service.js';
import { RequisitionSkillRequirementRepository } from './requisition-skill-requirement.repository.js';
import { RequisitionSkillCanonicalizationService } from './requisition-skill-canonicalization.service.js';

// SKILL-TAX-1D — requisition skill canonical-reconciliation orchestrator module.
//
// Imports JobDomainModule (read authored GoldenProfile skills via
// JobDomainRepository) and SkillsTaxonomyModule (the read-only
// SkillCanonicalizationService; NestJS dedupes it with apps/api's existing
// import — one instance, one BullMQ registration; this module adds NO BullMQ of
// its own). Provides the requisition PrismaService + the RequisitionSkillRequirement
// repository + the reconciliation orchestrator.
//
// No new HTTP surface, no new permission scope, no matching-authority change.
// Production triggering of the worker is a governed apps/api bootstrap concern —
// not wired to an automatic cron here.
@Module({
  imports: [JobDomainModule, SkillsTaxonomyModule],
  providers: [
    PrismaService,
    RequisitionSkillRequirementRepository,
    RequisitionSkillCanonicalizationService,
  ],
  exports: [RequisitionSkillCanonicalizationService, RequisitionSkillRequirementRepository],
})
export class RequisitionSkillCanonicalizationModule {}
