import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { ClientSelectionModule } from '@aramo/client-selection';
import { ClientTalentRestrictionModule } from '@aramo/client-talent-restriction';
import { CompanyModule } from '@aramo/company';
import { EntitlementModule } from '@aramo/entitlement';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { SubmittalModule } from '@aramo/submittal';
import { SubmittalEligibilityModule } from '@aramo/submittal-eligibility';
import { TalentRecordModule } from '@aramo/talent-record';
import { TaskModule } from '@aramo/task';

import { DocumentReadinessModule } from '../rtr/document-readiness.module.js';
import { EngagementGateModule } from '../engagement/engagement-gate.module.js';
import { OfferModule } from '../offer/offer.module.js';
import { PlacementModule } from '../placement/placement.module.js';

import { MyDeskReadAdapter } from './my-desk.adapters.js';
import { MyDeskController } from './my-desk.controller.js';
import { MY_DESK_READ_PORT } from './my-desk.ports.js';
import { MyDeskService } from './my-desk.service.js';

// MyDeskModule — the apps/api composition root for GET /v1/my-desk. It imports
// every OWNER module for its exported READ repository (Task / Requisition /
// Pipeline / ClientSelection / TalentRecord / Company / Placement / Offer) plus
// the guard modules for the @UseGuards chain. It crosses the A7 seam
// deliberately — the reporting lib may NOT read submittal/selection rows, so the
// desk composition lives HERE, at the layer that may depend on many domains.
// TaskModule is imported in its static form: only TaskRepository.listForAssignee
// (a read needing PrismaService alone) is used — the write-path assignee
// validator is irrelevant to this read surface.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TaskModule,
    RequisitionModule,
    PipelineModule,
    ClientSelectionModule,
    TalentRecordModule,
    CompanyModule,
    PlacementModule,
    OfferModule,
    // Submittal-readiness authorities (the same domain seams the Requisition
    // Talent Board composes) for the derived work kinds — no policy duplicated.
    SubmittalEligibilityModule,
    SubmittalModule,
    ClientTalentRestrictionModule,
    DocumentReadinessModule,
    EngagementGateModule,
  ],
  controllers: [MyDeskController],
  providers: [
    MyDeskService,
    MyDeskReadAdapter,
    { provide: MY_DESK_READ_PORT, useClass: MyDeskReadAdapter },
  ],
})
export class MyDeskModule {}
