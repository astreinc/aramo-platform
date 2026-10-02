import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { PrismaService as SubmittalEligibilityPrismaService, SubmittalEligibilityModule } from '@aramo/submittal-eligibility';

import { EngagementGateModule } from '../engagement/engagement-gate.module.js';
import { DocumentReadinessModule } from '../rtr/document-readiness.module.js';
import { ClientSubmittalPolicyModule } from '../client-submittal-policy/client-submittal-policy.module.js';

import { SubmittalWorkspaceController } from './submittal-workspace.controller.js';
import { SubmittalWorkspaceService } from './submittal-workspace.service.js';

// SW-4 — the apps/api composition root for GET /v1/submittals/:id/workspace. READ
// ONLY. Imports the guard modules for the @UseGuards chain + the read-only domain
// seams the composition reuses (engagement readiness, document/RTR readiness, client
// submittal policy). All other sources are tenant-scoped parameterized raw SQL on ONE
// connection ('SubmittalWorkspaceDb' = the submittal-eligibility PrismaService, the
// submit-talent 'SubmitTalentDb' precedent) — no owner write model/schema/command is
// touched, and no new read-model is persisted.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    SubmittalEligibilityModule,
    EngagementGateModule,
    DocumentReadinessModule,
    ClientSubmittalPolicyModule,
  ],
  controllers: [SubmittalWorkspaceController],
  providers: [
    SubmittalWorkspaceService,
    { provide: 'SubmittalWorkspaceDb', useExisting: SubmittalEligibilityPrismaService },
  ],
})
export class SubmittalWorkspaceModule {}
