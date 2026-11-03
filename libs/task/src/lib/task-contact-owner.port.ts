// Tasks backend — the contact-OWNER link PORT (CONTACTS-1 SD-6). Same precedent
// as TASK_ASSIGNEE_VALIDATOR / TASK_REQUISITION_CONTEXT_VALIDATOR: a lib-defined
// interface + token bound to a live adapter in apps/api. Keeps libs/task
// LEAF-clean — no @aramo/contact edge from the task lib; apps/api binds the
// adapter over ContactRepository.assertLinkable.
//
// Rule: a Task whose owner_type is 'contact' may only be created on a live
// contact in the tenant. A deleted contact accepts no new links (CONTACT_DELETED
// 422); a contact absent from the tenant is VALIDATION_ERROR 422. The owner is
// immutable after create (R6), so create is the only link point.

export const TASK_CONTACT_OWNER_VALIDATOR = Symbol('TASK_CONTACT_OWNER_VALIDATOR');

export interface TaskContactOwnerValidator {
  // Resolves when contact_id is a live contact in tenant_id; throws the typed
  // AramoError refusal otherwise.
  assertLinkable(args: {
    tenant_id: string;
    contact_id: string;
    requestId: string;
  }): Promise<void>;
}

// Accept-any TEST DOUBLE — resolves for every contact. Specs inject this to
// isolate controller behavior from the Contact substrate. NEVER a prod default.
export class StubTaskContactOwnerValidator implements TaskContactOwnerValidator {
  async assertLinkable(): Promise<void> {
    return;
  }
}

// Fail-CLOSED plain-import default (mirrors UnboundTaskAssigneeValidator): an
// accidental plain `TaskModule` import throws on first call rather than
// silently linking a task to a deleted contact. Prod binds the live adapter
// via TaskModule.forRoot({ contactOwnerValidator }).
export class UnboundTaskContactOwnerValidator implements TaskContactOwnerValidator {
  async assertLinkable(): Promise<void> {
    throw new Error(
      'TASK_CONTACT_OWNER_VALIDATOR is unbound — TaskModule must be imported via ' +
        'TaskModule.forRoot({ contactOwnerValidator }). The accept-any stub is a ' +
        'test double only and is never a prod default.',
    );
  }
}
