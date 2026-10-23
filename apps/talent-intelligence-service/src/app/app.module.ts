import { Module } from '@nestjs/common';
import { IntelligenceCoreModule } from '@aramo/intelligence-core';

import { OAuthTokenController } from './auth/oauth-token.controller.js';
import { ServiceTokenGuard } from './auth/service-token.guard.js';
import { HealthController } from './health.controller.js';
import { IngestController } from './ingest/ingest.controller.js';

// ATI-SEP-1 — composition root. Imports scope:intelligence + scope:shared
// libraries ONLY (eslint depConstraints; never an ATS or Pipeline library).
// T0 health · T2 token exchange + ingestion.
@Module({
  imports: [IntelligenceCoreModule],
  controllers: [HealthController, OAuthTokenController, IngestController],
  providers: [ServiceTokenGuard],
})
export class AppModule {}
