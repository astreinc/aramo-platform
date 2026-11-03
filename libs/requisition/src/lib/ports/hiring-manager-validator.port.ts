// CONTACTS-1 HM-1 / SD-6 — the port by which requisition validates its hiring
// manager (Requisition.contact_id) WITHOUT taking a dependency on @aramo/contact
// (requisition stays decoupled — see requisition.module.ts "No imports of
// @aramo/company or @aramo/contact"). apps/api binds the contact-backed adapter
// at composition; libs/requisition specs provide a fake. In-process DI seam, not
// a network connector — the contract is this TypeScript interface.
//
// The adapter refuses (422) a contact_id that is not in the tenant
// (VALIDATION_ERROR reason 'contact_not_found'), not at the requisition's
// company (VALIDATION_ERROR reason 'contact_company_mismatch'), or deleted
// (CONTACT_DELETED). Callers invoke it only for a non-null contact_id; null
// (no hiring manager) stays allowed.

// String token (NOT a bare class type), same collision-safety reasoning as
// COMPANY_CLIENT_CHECK_PORT.
export const REQUISITION_HIRING_MANAGER_VALIDATOR =
  'REQUISITION_HIRING_MANAGER_VALIDATOR';

export interface RequisitionHiringManagerValidator {
  assertLinkable(args: {
    readonly tenant_id: string;
    readonly contact_id: string;
    readonly company_id: string;
    readonly requestId: string;
  }): Promise<void>;
}
