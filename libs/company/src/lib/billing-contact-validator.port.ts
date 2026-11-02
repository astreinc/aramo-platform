// CONTACTS-1 (SD-6) — the company billing-contact link check. A company's
// billing_contact_id must name a live contact AT that company. The contact
// lives in libs/contact, which libs/company does not import (no new nx edge),
// so the update path asserts the link through THIS port. The concrete adapter
// is bound by the composition root (apps/api) over ContactRepository.assertLinkable;
// the lib depends only on this interface. The adapter throws a typed AramoError
// when the contact is outside the tenant (VALIDATION_ERROR 422), at another
// company (VALIDATION_ERROR 422) or deleted (CONTACT_DELETED 422).
//
// Injected @Optional(): when no adapter is bound the update path keeps its
// pre-CONTACTS-1 behaviour (no link check).
export interface CompanyBillingContactValidator {
  assertLinkable(args: {
    tenant_id: string;
    contact_id: string;
    company_id: string;
    requestId: string;
  }): Promise<void>;
}

export const COMPANY_BILLING_CONTACT_VALIDATOR = Symbol('COMPANY_BILLING_CONTACT_VALIDATOR');
