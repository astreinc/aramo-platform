import { Module } from '@nestjs/common';
import { IntelligenceCoreModule } from '@aramo/intelligence-core';

import { OAuthTokenController } from './auth/oauth-token.controller.js';
import { ServiceTokenGuard } from './auth/service-token.guard.js';
import { EntitlementsController } from './entitlements/entitlements.controller.js';
import { HealthController } from './health.controller.js';
import { IngestController } from './ingest/ingest.controller.js';
import { ReferencesController } from './references/references.controller.js';
import { VerificationController } from './verification/verification.controller.js';
import { IntelligenceWorkers } from './workers/intelligence-workers.js';

// ATI-SEP-1 — composition root. Imports scope:intelligence + scope:shared
// libraries ONLY (eslint depConstraints; never an ATS or Pipeline library).
// T0 health · T2 token exchange + ingestion · T4 verification · T6 read API +
// entitlement sync · T5/T7 background workers (re-assessment, outbox drain).
@Module({
  imports: [IntelligenceCoreModule],
  controllers: [HealthController, OAuthTokenController, IngestController, VerificationController, ReferencesController, EntitlementsController],
  providers: [ServiceTokenGuard, IntelligenceWorkers],
})
export class AppModule {}
