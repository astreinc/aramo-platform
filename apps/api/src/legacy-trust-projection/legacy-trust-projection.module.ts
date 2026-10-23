import { Module } from '@nestjs/common';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentTrustModule } from '@aramo/talent-trust';

import { LegacyTrustProjectionService } from './legacy-trust-projection.service.js';

// TEMPORARY — ATI-SEP-1 §5; deleted at T10 when Talent Intelligence service
// ingestion replaces it. Never call from an ATS create/edit request path.
//
// ATI-SEP-1 A1 — hosts the typed-row → trust-ledger projection at the apps/api
// composition root (untagged, so the talent-evidence + talent-trust edges live
// here, not in the scope:ats producer libs). Consumers: ExamineController (Step
// 4b reconcile) and the claims-ledger backfill CLI.
@Module({
  imports: [TalentEvidenceModule, TalentTrustModule],
  providers: [LegacyTrustProjectionService],
  exports: [LegacyTrustProjectionService],
})
export class LegacyTrustProjectionModule {}
