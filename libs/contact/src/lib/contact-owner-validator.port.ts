// CONTACTS-1 §7 V-3 — the contact owner (owner_id) must be an assignable,
// active member of the tenant. libs/contact cannot read identity users without
// a new lib edge, so the check is a PORT bound in apps/api over the identity
// assignable-users read (the interviewer-validator pattern). Optional at
// injection: an unbound port skips the owner check.
export const CONTACT_OWNER_VALIDATOR = Symbol('CONTACT_OWNER_VALIDATOR');

export interface ContactOwnerValidator {
  // Refuses with 422 VALIDATION_ERROR details { field, reason: 'owner_not_assignable' }.
  assertAssignable(args: {
    tenant_id: string;
    user_id: string;
    requestId: string;
    field: string;
  }): Promise<void>;
}

// CONTACTS-1 §5 SD-11 — delete / restore are audited through the existing
// identity audit ledger. Like the owner check this is a PORT bound in apps/api
// (no contact -> identity lib edge). Best-effort, as the ledger writer is:
// an unbound port records nothing.
export const CONTACT_AUDIT_SINK = Symbol('CONTACT_AUDIT_SINK');

export interface ContactAuditSink {
  record(args: {
    event: 'deleted' | 'restored';
    tenant_id: string;
    actor_id: string;
    contact_id: string;
    company_id: string;
  }): Promise<void>;
}
