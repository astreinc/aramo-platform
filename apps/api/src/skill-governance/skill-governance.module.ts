import { Module } from '@nestjs/common';
import { CommonModule, createAramoLogger } from '@aramo/common';
import { CanonicalReconcileModule } from '@aramo/canonical-reconcile';
import { SkillsTaxonomyModule } from '@aramo/skills-taxonomy';
import { TalentSkillCanonicalizationModule } from '@aramo/talent-evidence';
import { RequisitionSkillCanonicalizationModule } from '@aramo/requisition';

import { SkillCorrectionProcessor } from './skill-correction.processor.js';

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
    CanonicalReconcileModule,
    SkillsTaxonomyModule,
    TalentSkillCanonicalizationModule,
    RequisitionSkillCanonicalizationModule,
  ],
  providers: [
    SkillCorrectionProcessor,
    {
      provide: 'SkillCorrectionProcessorLogger',
      useFactory: () => createAramoLogger(SkillCorrectionProcessor.name),
    },
  ],
  exports: [SkillCorrectionProcessor],
})
export class SkillGovernanceModule {}
