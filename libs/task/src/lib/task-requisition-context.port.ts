// Tasks backend — the requisition-CONTEXT validation PORT (CRM-6, §10 PO
// ruling rule 3). Same precedent as TASK_ASSIGNEE_VALIDATOR: a lib-defined
// interface + token bound to a live adapter in apps/api. Keeps libs/task
// LEAF-clean — no @aramo/pipeline edge from the task lib; apps/api binds the
// adapter that reads the Pipeline substrate.
//
// Rule: a Talent-owned task's OPTIONAL requisition_id must reference a
// requisition the Talent has a REAL pipeline relationship to (same tenant).
// Never trust an arbitrary requisition UUID from the picker.

export const TASK_REQUISITION_CONTEXT_VALIDATOR = Symbol(
  'TASK_REQUISITION_CONTEXT_VALIDATOR',
);

export interface TaskRequisitionContextValidator {
  // True iff `talent_id` has a Pipeline relationship to `requisition_id` within
  // `tenant_id` (the Talent is/was on that requisition's pipeline).
  talentHasRequisitionPipeline(args: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
  }): Promise<boolean>;
}

// Accept-any TEST DOUBLE — returns true for every pair. Specs inject this to
// isolate controller behavior from the Pipeline substrate. NEVER a prod default.
export class StubTaskRequisitionContextValidator
  implements TaskRequisitionContextValidator
{
  async talentHasRequisitionPipeline(): Promise<boolean> {
    return true;
  }
}

// Fail-CLOSED plain-import default (mirrors UnboundTaskAssigneeValidator): an
// accidental plain `TaskModule` import throws on first call rather than
// silently approving an arbitrary requisition context. Prod binds the live
// adapter via TaskModule.forRoot({ requisitionContextValidator }).
export class UnboundTaskRequisitionContextValidator
  implements TaskRequisitionContextValidator
{
  async talentHasRequisitionPipeline(): Promise<boolean> {
    throw new Error(
      'TASK_REQUISITION_CONTEXT_VALIDATOR is unbound — TaskModule must be ' +
        'imported via TaskModule.forRoot({ requisitionContextValidator }). The ' +
        'accept-any stub is a test double only and is never a prod default.',
    );
  }
}
