import { Module } from '@nestjs/common';
import { CommonModule } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import { TalentRepository } from './talent.repository.js';
import { TalentService } from './talent.service.js';

// libs/talent module: expanded from the PR-1 scaffold in PR-10.
// Provides Talent + TalentTenantOverlay CRUD via TalentService.
//
// Repositories AND services are the public surface — TalentService and
// TalentRepository are exported for cross-lib consumers. PrismaService
// remains internal (per the post-PR-17 lazy-validation contract: only
// the owning lib instantiates PrismaService). The original
// services-only posture was amended at M5 PR-3 to align with the
// workspace-wide repository-as-public-export pattern adopted by all
// other M3+ libs (libs/job-domain, libs/examination, libs/evidence,
// libs/submittal, libs/engagement). The trigger: M5 PR-3's
// EngagementRepository.createEngagement Pattern C cross-schema
// validator (Amendment v1.1 §2) injects TalentRepository directly via
// Nest DI, which requires the @Module.exports declaration here.
@Module({
  imports: [CommonModule],
  providers: [PrismaService, TalentRepository, TalentService],
  exports: [TalentService, TalentRepository],
})
export class TalentModule {}
