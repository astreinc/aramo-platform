// Tasks backend — the assignee-validation PORT (the S3a TenantCognitoPort /
// S4 AuditFinancialsGate precedent: a lib-defined interface + token, bound to
// a live adapter in apps/api). Keeps libs/task LEAF-clean — no @aramo/identity
// edge from the task lib; apps/api binds the adapter that reads
// IdentityService.findMembership (the GET /v1/tenant/users roster's substrate).
//
// Ruling R5: an assignee must be an ACTIVE within-tenant member. Cross-tenant
// or inactive → rejected at create/reassign (VALIDATION_ERROR, app layer).

export const TASK_ASSIGNEE_VALIDATOR = Symbol('TASK_ASSIGNEE_VALIDATOR');

export interface TaskAssigneeValidator {
  // True iff user_id is an ACTIVE member of tenant_id (an assignable user).
  isActiveTenantMember(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<boolean>;
}

// Test/default stub — accepts any assignee. apps/api overrides with the live
// identity-backed adapter; specs inject a controllable fake.
export class StubTaskAssigneeValidator implements TaskAssigneeValidator {
  async isActiveTenantMember(): Promise<boolean> {
    return true;
  }
}
