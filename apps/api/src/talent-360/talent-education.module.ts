import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentRecordModule } from '@aramo/talent-record';
import { TalentTrustModule } from '@aramo/talent-trust';

import { TalentEducationController } from './talent-education.controller.js';
import { TalentEducationService } from './talent-education.service.js';

// ATS-QA-1 I-4 (L2) — the education WRITE surface, kept apart from the read-only
// Talent 360 composition. It owns no schema: entries + lineage + audit live in
// talent_evidence (TalentEducationRepository), claims in talent_trust.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TalentEvidenceModule,
    TalentRecordModule,
    TalentTrustModule,
  ],
  controllers: [TalentEducationController],
  providers: [TalentEducationService],
})
export class TalentEducationModule {}
