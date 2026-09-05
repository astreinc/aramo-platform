import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { createAramoLogger } from '@aramo/common';
import { ConsentModule } from '@aramo/consent';
import { SubmittalModule } from '@aramo/submittal';
import {
  SubmittalEligibilityModule,
  PrismaService as SubmittalEligibilityPrismaService,
} from '@aramo/submittal-eligibility';

import { EngagementGateModule } from '../engagement/engagement-gate.module.js';

import { SubmitTalentController } from './submit-talent.controller.js';
import { SubmitTalentToClientService } from './submit-talent.service.js';

// Lane L8-B1 — the "Submit Talent to Client" composition root (apps/api). This
// is the one place @aramo/submittal, @aramo/pipeline, @aramo/submittal-eligibility
// and the activity/metering helpers meet — a shared atomic transaction boundary
// (the pre-start-requirement precedent). The orchestrator opens ONE interactive
// transaction on the submittal-eligibility connection (bound as 'SubmitTalentDb')
// and issues cross-schema parameterized raw SQL confined to that boundary.
@Module({
  imports: [AuthModule, SubmittalEligibilityModule, SubmittalModule, ConsentModule, EngagementGateModule],
  controllers: [SubmitTalentController],
  providers: [
    SubmitTalentToClientService,
    {
      provide: 'SubmitTalentDb',
      useExisting: SubmittalEligibilityPrismaService,
    },
    {
      provide: 'SubmitTalentToClientLogger',
      useFactory: () => createAramoLogger(SubmitTalentToClientService.name),
    },
  ],
})
export class SubmitTalentModule {}
