import { Module } from '@nestjs/common';
import { AuthModule } from '@aramo/auth';
import { AuthorizationModule } from '@aramo/authorization';
import { EntitlementModule } from '@aramo/entitlement';
import { TalentRecordModule } from '@aramo/talent-record';
import { RequisitionModule } from '@aramo/requisition';
import { CompanyModule } from '@aramo/company';
import { ContactModule } from '@aramo/contact';

import { ENTERPRISE_SEARCH_PORT } from './enterprise-search.port.js';
import { SEARCH_ENTITY_ADAPTERS, type SearchEntityAdapter } from './search-entity-adapter.js';
import { EnterpriseSearchReadService } from './enterprise-search-read.service.js';
import { EnterpriseSearchController } from './enterprise-search.controller.js';
import { TalentSearchAdapter } from './adapters/talent-search.adapter.js';
import { RequisitionSearchAdapter } from './adapters/requisition-search.adapter.js';
import { CompanySearchAdapter } from './adapters/company-search.adapter.js';
import { ContactSearchAdapter } from './adapters/contact-search.adapter.js';

// Enterprise Search (GS-1) — the apps/api composition module. Imports the four owner modules
// for their EXPORTED repositories (the adapters inject them), plus the guard modules for the
// ATS chain. Provides the four per-domain adapters, composes them into the SEARCH_ENTITY_ADAPTERS
// array, and binds the orchestrator under the ENTERPRISE_SEARCH_PORT string token (per the
// non-strict-lookup collision rule). GET-only; the module owns no write model.
@Module({
  imports: [
    AuthModule,
    AuthorizationModule,
    EntitlementModule,
    TalentRecordModule,
    RequisitionModule,
    CompanyModule,
    ContactModule,
  ],
  controllers: [EnterpriseSearchController],
  providers: [
    TalentSearchAdapter,
    RequisitionSearchAdapter,
    CompanySearchAdapter,
    ContactSearchAdapter,
    {
      provide: SEARCH_ENTITY_ADAPTERS,
      useFactory: (
        talent: TalentSearchAdapter,
        requisition: RequisitionSearchAdapter,
        company: CompanySearchAdapter,
        contact: ContactSearchAdapter,
      ): SearchEntityAdapter[] => [talent, requisition, company, contact],
      inject: [TalentSearchAdapter, RequisitionSearchAdapter, CompanySearchAdapter, ContactSearchAdapter],
    },
    { provide: ENTERPRISE_SEARCH_PORT, useClass: EnterpriseSearchReadService },
  ],
})
export class EnterpriseSearchModule {}
