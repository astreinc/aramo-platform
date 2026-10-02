import { Injectable } from '@nestjs/common';
import { PipelineRepository } from '@aramo/pipeline';
import type { TaskRequisitionContextValidator } from '@aramo/task';

// Tasks backend — TaskRequisitionContextAdapter (live implementation of the
// TASK_REQUISITION_CONTEXT_VALIDATOR port declared in libs/task, CRM-6 §10).
//
// Validates that a Talent has a REAL Pipeline relationship to a requisition
// before that requisition may be recorded as a follow-up task's OPTIONAL
// context. The adapter is the only place libs/task (via its port) and
// libs/pipeline meet — both stay leaf-clean (libs/task has NO @aramo/pipeline
// import). The TaskAssigneeAdapter / TenantCognitoAdapter port precedent.
//
// Existence check only (visible_requisition_ids: null = tenant-scoped): the
// actor-visibility of the requisition is asserted SEPARATELY in the controller
// (isOwnerVisible) before this runs, so this answers purely "is the Talent on
// that requisition's pipeline".
@Injectable()
export class TaskRequisitionContextAdapter
  implements TaskRequisitionContextValidator
{
  constructor(private readonly pipelines: PipelineRepository) {}

  async talentHasRequisitionPipeline(args: {
    tenant_id: string;
    talent_id: string;
    requisition_id: string;
  }): Promise<boolean> {
    const rows = await this.pipelines.listForActor({
      tenant_id: args.tenant_id,
      visible_requisition_ids: null,
      requisition_id: args.requisition_id,
      talent_record_id: args.talent_id,
      limit: 1,
    });
    return rows.length > 0;
  }
}
