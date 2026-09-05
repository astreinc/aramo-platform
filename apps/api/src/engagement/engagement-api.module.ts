import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';

import { EngagementGateModule } from './engagement-gate.module.js';
import { EngagementController } from './engagement.controller.js';

// COMM-C3 — the Engagement admin + readiness HTTP surface. Reuses the
// EngagementGateModule (policy service + gate service) and the three-axis guard
// modules. NO recruiting execution, NO Pipeline mutation.
@Module({
  imports: [AuthModule, AuthorizationModule, EntitlementModule, EngagementGateModule],
  controllers: [EngagementController],
})
export class EngagementApiModule {}
