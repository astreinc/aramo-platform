import { Global, Module } from '@nestjs/common';
import { COMPANY_BILLING_CONTACT_VALIDATOR } from '@aramo/company';
import { CONTACT_OWNER_VALIDATOR, ContactModule } from '@aramo/contact';
import { IdentityCoreModule } from '@aramo/identity';
import { REQUISITION_HIRING_MANAGER_VALIDATOR } from '@aramo/requisition';

import {
  CompanyBillingContactAdapter,
  ContactOwnerAdapter,
  RequisitionHiringManagerAdapter,
} from './contact-link-validators.adapter.js';

// CONTACTS-1 (SD-6 / HM-1 / V-3) — binds the contact-link ports to their
// composition-root adapters. @Global so the lib providers that inject the
// tokens (RequisitionRepository, CompanyRepository, the contact library's owner
// check) resolve them from their own modules without importing contact or
// identity. ContactModule supplies ContactRepository; IdentityCoreModule is the
// SHARED identity read surface (the InterviewerValidatorModule precedent). The
// task port is bound separately, in TaskModule's own scope, via
// TaskModule.forRoot in app.module.ts.
@Global()
@Module({
  imports: [ContactModule, IdentityCoreModule],
  providers: [
    RequisitionHiringManagerAdapter,
    CompanyBillingContactAdapter,
    ContactOwnerAdapter,
    {
      provide: REQUISITION_HIRING_MANAGER_VALIDATOR,
      useExisting: RequisitionHiringManagerAdapter,
    },
    {
      provide: COMPANY_BILLING_CONTACT_VALIDATOR,
      useExisting: CompanyBillingContactAdapter,
    },
    { provide: CONTACT_OWNER_VALIDATOR, useExisting: ContactOwnerAdapter },
  ],
  exports: [
    REQUISITION_HIRING_MANAGER_VALIDATOR,
    COMPANY_BILLING_CONTACT_VALIDATOR,
    CONTACT_OWNER_VALIDATOR,
  ],
})
export class ContactLinkValidatorsModule {}
