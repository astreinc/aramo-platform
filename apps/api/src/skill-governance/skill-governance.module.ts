import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { CanonicalReconcileModule } from '@aramo/canonical-reconcile';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { TalentSkillCanonicalizationModule } from '@aramo/talent-evidence';
import { RequisitionSkillCanonicalizationModule } from '@aramo/requisition';

import { SkillCorrectionProcessor } from './skill-correction.processor.js';
import { SkillGovernanceController } from './skill-governance.controller.js';
import { SkillReviewQueueService } from './skill-review-queue.service.js';

// SKILL-TAX-1F-B1 — the durable correction/propagation engine (internal; NO HTTP
// surface — that is 1F-B2). Provides the SkillCorrectionProcessor, the ONLY place
// bridging skills-taxonomy + talent-evidence (scope:cip) and requisition (scope:ats)
// to drain the durable SkillCorrectionTask ledger. It pulls: the ledger repo
// (SkillsTaxonomyModule), the Talent correction repo (TalentSkillCanonicalizationModule),
// the requisition requirement repo (RequisitionSkillCanonicalizationModule), the
// reconcile producer (CanonicalReconcileModule), and RedisConnectionConfig (CommonModule).
@Module({
  imports: [
    CommonModule,
    // SKILL-TAX-1F-B2 — the platform governance HTTP surface needs the auth + scope
    // guards (JwtAuthGuard, RolesGuard); leaf guard imports keep lint:nx-boundaries acyclic.
    AuthModule,
    AuthorizationModule,
    CanonicalReconcileModule,
    SkillsTaxonomyModule,
    TalentSkillCanonicalizationModule,
    RequisitionSkillCanonicalizationModule,
  ],
  controllers: [SkillGovernanceController],
  providers: [
    SkillCorrectionProcessor,
    // SKILL-TAX-1F-B2 — the cross-domain review-queue union (apps/api-only; bridges
    // scope:cip talent-evidence + scope:ats requisition, counts-only response).
    SkillReviewQueueService,
    {
      provide: 'SkillCorrectionProcessorLogger',
      useFactory: () => createAramoLogger(SkillCorrectionProcessor.name),
    },
  ],
  exports: [SkillCorrectionProcessor],
})
export class SkillGovernanceModule {}
