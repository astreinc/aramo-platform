import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { IntelligenceIntegrationModule } from '@aramo/intelligence-integration';
import { PortalModule } from '@aramo/portal';

import { IntelligenceEventsController } from './intelligence-events.controller.js';
import { PortalIdentifierVerificationController } from './portal-identifier-verification.controller.js';

// ATI-SEP-1 T8 — the ATS HTTP surface of the Talent Intelligence integration:
// the HMAC webhook receiver and the (gated) portal identifier verification.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, PortalModule, IntelligenceIntegrationModule],
  controllers: [IntelligenceEventsController, PortalIdentifierVerificationController],
})
export class IntelligenceIntegrationHttpModule {}
