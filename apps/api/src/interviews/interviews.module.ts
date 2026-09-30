import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { ClientSelectionModule } from '@aramo/client-selection';
import { CompanyModule } from '@aramo/company';
import { EntitlementModule } from '@aramo/entitlement';
import { RequisitionModule } from '@aramo/requisition';
import { TalentRecordModule } from '@aramo/talent-record';

import { InterviewsReadAdapter } from './interviews.adapters.js';
import { InterviewsController } from './interviews.controller.js';
import { INTERVIEWS_READ_PORT } from './interviews.ports.js';
import { InterviewsService } from './interviews.service.js';

// InterviewsModule — the apps/api composition root for GET /v1/interviews (the interview
// CALENDAR read). Imports the owner modules for their exported READ repositories
// (ClientSelection = the InterviewSession authority, Requisition, TalentRecord, Company)
// plus the guard modules for the @UseGuards chain. A read projection only — no interview
// authority lives here (Calendar/Interview §2).
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    ClientSelectionModule,
    RequisitionModule,
    TalentRecordModule,
    CompanyModule,
  ],
  controllers: [InterviewsController],
  providers: [
    InterviewsService,
    InterviewsReadAdapter,
    { provide: INTERVIEWS_READ_PORT, useClass: InterviewsReadAdapter },
  ],
})
export class InterviewsModule {}
