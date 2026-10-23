import { Module } from '@nestjs/common';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentEvidenceModule } from '@aramo/talent-evidence';
import { TalentRecordModule } from '@aramo/talent-record';

import { INTELLIGENCE_INTEGRATION_CONFIG, loadIntelligenceConfig } from './intelligence-config.js';
import { IntelligenceBackfillService } from './intelligence-backfill.service.js';
import { IntelligenceClient } from './intelligence-client.js';
import { IntelligenceEntitlementSyncService } from './intelligence-entitlement-sync.service.js';
import { IntelligenceInboundSyncService } from './intelligence-inbound-sync.service.js';
import { IntelligenceIntegrationWorker } from './intelligence-integration.worker.js';
import { IntelligencePublisherHandler } from './intelligence-publisher.handler.js';
import { IntelligenceVerificationService } from './intelligence-verification.service.js';
import { IntelligenceWebhookReceiver } from './intelligence-webhook.receiver.js';

// ATI-SEP-1 T8 (ADR-0036 §3) — the ATS side of the ATS ↔ Talent Intelligence
// integration (scope:ats). It reaches TI over HTTP only, through
// @aramo/intelligence-contracts (scope:shared) — never a scope:intelligence
// library (the A7 wall, eslint-enforced). Every TI env var is optional: with TI
// unconfigured every member is an inert no-op and the ATS works unchanged.
@Module({
  imports: [EntitlementModule, TalentRecordModule, TalentEvidenceModule],
  providers: [
    { provide: INTELLIGENCE_INTEGRATION_CONFIG, useFactory: () => loadIntelligenceConfig() },
    IntelligenceClient,
    IntelligenceEntitlementSyncService,
    IntelligencePublisherHandler,
    IntelligenceInboundSyncService,
    IntelligenceWebhookReceiver,
    IntelligenceVerificationService,
    IntelligenceIntegrationWorker,
    IntelligenceBackfillService,
  ],
  exports: [
    INTELLIGENCE_INTEGRATION_CONFIG,
    IntelligenceClient,
    IntelligenceEntitlementSyncService,
    IntelligencePublisherHandler,
    IntelligenceInboundSyncService,
    IntelligenceWebhookReceiver,
    IntelligenceVerificationService,
    IntelligenceBackfillService,
  ],
})
export class IntelligenceIntegrationModule {}
