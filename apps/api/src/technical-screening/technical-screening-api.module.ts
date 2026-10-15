import { Module } from '@nestjs/common';
import { AiDraftModule } from '@aramo/ai-draft';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { JobDomainModule } from '@aramo/job-domain';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentRecordModule } from '@aramo/talent-record';
import { TalentTrustModule } from '@aramo/talent-trust';
import { TechnicalScreeningModule } from '@aramo/technical-screening';

import { ScreeningTrustPublisherAdapter } from './screening-trust-publisher.adapter.js';
import { ScreeningAccessService } from './screening-access.service.js';
import { ScreeningAiConsentAdapter } from './screening-ai-consent.adapter.js';
import { ScreeningContextReader } from './screening-context.reader.js';
import {
  ScreeningSessionController,
  TalentScreeningSessionsController,
} from './technical-screening.controller.js';

// TIP-E2E INC-3 — the Technical Screening HTTP surface (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8/§9).
// TechnicalScreeningModule is registered with the REQUIRED Talent Trust publisher
// adapter (a missing adapter fails at bootstrap). The domain module is re-exported
// so the record-reconcile orchestrator can inject TechnicalScreeningRepository
// for the talent-merge re-key (§10.3).
const ScreeningDomain = TechnicalScreeningModule.register({
  publisher: ScreeningTrustPublisherAdapter,
  // INC-3 A1-3 — the existing ai_processing consent operation, fail closed.
  aiConsent: ScreeningAiConsentAdapter,
  imports: [TalentTrustModule, AiDraftModule, ConsentModule],
});

@Module({
  imports: [
    AuthModule,
    ConsentModule,
    EntitlementModule,
    TalentRecordModule,
    TalentTrustModule,
    JobDomainModule,
    TalentEvidenceModule,
    ScreeningDomain,
  ],
  controllers: [TalentScreeningSessionsController, ScreeningSessionController],
  providers: [ScreeningAccessService, ScreeningContextReader],
  exports: [ScreeningDomain],
})
export class TechnicalScreeningApiModule {}
