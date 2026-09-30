import { Module } from '@nestjs/common';
import { ActivityModule } from '@aramo/activity';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { ClientSelectionModule } from '@aramo/client-selection';
import { CommunicationsModule } from '@aramo/communications';
import { CompanyModule } from '@aramo/company';
import { ConsentModule } from '@aramo/consent';
import { DocumentsModule } from '@aramo/documents';
import { EntitlementModule } from '@aramo/entitlement';
import { IdentityModule } from '@aramo/identity';
import { PipelineModule } from '@aramo/pipeline';
import { RequisitionModule } from '@aramo/requisition';
import { TalentExtractionModule } from '@aramo/talent-extraction';
import { TalentRecordModule } from '@aramo/talent-record';
import { TaskModule } from '@aramo/task';

import { TalentIdentityModule } from '../talent-identity/talent-identity.module.js';
import { TalentJourneyModule } from '../talent-journey/talent-journey.module.js';

import { Talent360ReadAdapter } from './talent-360.adapters.js';
import { Talent360Controller } from './talent-360.controller.js';
import { TALENT_360_READ_PORT } from './talent-360.ports.js';
import { Talent360Service } from './talent-360.service.js';

// Talent360Module — the apps/api composition root for GET /v1/talent-360/:id.
// It imports every OWNER module for its EXPORTED read repository/service (Talent
// / Pipeline / Requisition / Company / Client-Selection / Communications /
// Activity / Task / Documents / Consent / Identity / Talent-Extraction) plus the
// reused composers (TalentJourneyModule for the per-episode journey; the
// TalentIdentityModule for the DossierService identity outcomes) and the guard
// modules for the @UseGuards chain. It crosses the many-owners seam deliberately
// — only apps/api may know all owners (the My Desk / Talent Journey precedent);
// a single domain lib may not compose across the whole ATS. This module reads
// only: no owner write model, schema, or command is touched.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TalentRecordModule,
    PipelineModule,
    RequisitionModule,
    CompanyModule,
    ClientSelectionModule,
    CommunicationsModule,
    ActivityModule,
    TaskModule,
    DocumentsModule,
    ConsentModule,
    IdentityModule,
    TalentExtractionModule,
    TalentJourneyModule,
    TalentIdentityModule,
  ],
  controllers: [Talent360Controller],
  providers: [
    Talent360Service,
    Talent360ReadAdapter,
    { provide: TALENT_360_READ_PORT, useClass: Talent360ReadAdapter },
  ],
})
export class Talent360Module {}
