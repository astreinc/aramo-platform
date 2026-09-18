import { Module } from '@nestjs/common';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentEvidenceRepository } from './talent-evidence.repository.js';
import { TalentSkillCanonicalizationService } from './talent-skill-canonicalization.service.js';
import { TalentCanonicalCoverageRepository } from './talent-canonical-coverage.repository.js';
import { TalentCanonicalCorrectionRepository } from './talent-canonical-correction.repository.js';

// SKILL-TAX-1G — Talent skill canonical-reconciliation orchestrator module.
//
// Imports SkillsTaxonomyModule for the read-only SkillCanonicalizationService
// (NestJS dedupes it with apps/api's existing import — one instance, one BullMQ
// registration; this module adds NO BullMQ of its own). Provides the
// talent-evidence PrismaService + repository + the reconciliation orchestrator.
//
// No new HTTP surface, no new permission scope (1G is internal reconciliation).
// Production triggering of the worker is a governed apps/api bootstrap concern
// per the 1G ruling — not wired to an automatic cron here.
@Module({
  imports: [SkillsTaxonomyModule],
  providers: [
    PrismaService,
    TalentEvidenceRepository,
    TalentSkillCanonicalizationService,
    TalentCanonicalCoverageRepository,
    TalentCanonicalCorrectionRepository,
  ],
  exports: [
    TalentSkillCanonicalizationService,
    TalentCanonicalCoverageRepository,
    TalentCanonicalCorrectionRepository,
  ],
})
export class TalentSkillCanonicalizationModule {}
