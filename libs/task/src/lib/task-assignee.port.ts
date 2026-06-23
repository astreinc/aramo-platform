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

// Accept-any TEST DOUBLE — returns true for every assignee. NOT a
// prod-reachable default any more (Task-Assignee Binding-Fix v1.0): the
// former @Module-scoped default binding silently accepted cross-tenant /
// inactive assignees because AppModule's override never reached
// TaskController's module scope (per-module hierarchical DI). It survives
// solely so specs can inject the old accept-any behavior to PROVE the
// rebind changes behavior. Prod binds the live adapter via
// TaskModule.forRoot({ assigneeValidator }).
export class StubTaskAssigneeValidator implements TaskAssigneeValidator {
  async isActiveTenantMember(): Promise<boolean> {
    return true;
  }
}

// Fail-CLOSED plain-import default (Task-Assignee Binding-Fix v1.0). Bound in
// TaskModule's @Module providers so an accidental plain `TaskModule` import
// (there are none today — apps/api is the sole importer and uses forRoot)
// fails SAFE rather than open: it throws on first call instead of silently
// approving any assignee. The cognito StubTenantCognitoAdapter fail-loud
// precedent — never fake-succeed. The Lead-sanctioned defense-in-depth
// option; the load-bearing path is forRoot binding the real adapter.
export class UnboundTaskAssigneeValidator implements TaskAssigneeValidator {
  async isActiveTenantMember(): Promise<boolean> {
    throw new Error(
      'TASK_ASSIGNEE_VALIDATOR is unbound — TaskModule must be imported via ' +
        'TaskModule.forRoot({ assigneeValidator }). The accept-any stub is a ' +
        'test double only and is never a prod default.',
    );
  }
}
