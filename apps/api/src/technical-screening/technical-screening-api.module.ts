import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { ConsentModule } from '@aramo/consent';
import { EntitlementModule } from '@aramo/entitlement';
import { JobDomainModule } from '@aramo/job-domain';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentRecordModule } from '@aramo/talent-record';

import { ConversationTranscriptZoomModule } from '../conversation-transcript/conversation-transcript-zoom.module.js';
import { CiProcessingModule } from '../conversation-intelligence/ci-processing.module.js';
import { MicrosoftModule } from '../microsoft/microsoft.module.js';

import { ScreeningAccessService } from './screening-access.service.js';
import { ScreeningAiConsentAdapter } from './screening-ai-consent.adapter.js';
import { ScreeningContextReader } from './screening-context.reader.js';
import { ScreeningDomain } from './screening-domain.module.js';
import { ScreeningMeetingService } from './screening-meeting.service.js';
import { ScreeningRetentionService } from './screening-retention.service.js';
import {
  ScreeningSessionController,
  TalentScreeningSessionsController,
} from './technical-screening.controller.js';

// TIP-E2E INC-3 — the Technical Screening HTTP surface (ARAMO-TIP-E2E-INC-3-v1.0-LOCKED §8/§9).
// The domain registration lives in screening-domain.module.ts (shared with the
// CI screening profile). It is re-exported so the record-reconcile orchestrator
// can inject TechnicalScreeningRepository for the talent-merge re-key (§10.3).
@Module({
  imports: [
    AuthModule,
    ConsentModule,
    EntitlementModule,
    TalentRecordModule,
    JobDomainModule,
    TalentEvidenceModule,
    // INC-3 A1-4/A1-5 — the existing Outlook scheduling + Teams artifacts and
    // the B3/B4 transcript services (Teams provider registered there).
    MicrosoftModule,
    ConversationTranscriptZoomModule,
    // INC-3 A1-5 — schedules the CI screening profile for linked transcripts.
    CiProcessingModule,
    ScreeningDomain,
  ],
  controllers: [TalentScreeningSessionsController, ScreeningSessionController],
  providers: [ScreeningAccessService, ScreeningContextReader, ScreeningAiConsentAdapter, ScreeningMeetingService, ScreeningRetentionService],
  exports: [ScreeningDomain],
})
export class TechnicalScreeningApiModule {}
