import { Injectable } from '@nestjs/common';
import { PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

// COMM-C2B Amendment A1 (M365-SCHED-1, C-4) — shared meeting-association validator,
// reused by BOTH the create-link-only path and the new Outlook scheduling path.
// Closes the cross-tenant gap: the Talent and Requisition ids are never trusted
// from the request body — each must belong to the caller's tenant, and (where the
// workflow asserts a recruiting relationship) the Talent must hold a LIVE pipeline
// episode on that Requisition. Two independently valid records are NOT a valid
// recruiting association (Architect). Every check fails closed.

export type MeetingAssociationErrorKind =
  | 'talent_not_in_tenant'
  | 'requisition_not_in_tenant'
  | 'association_invalid';

export class MeetingAssociationError extends Error {
  constructor(
    readonly kind: MeetingAssociationErrorKind,
    readonly detail: string,
  ) {
    super(`meeting association invalid (${kind}: ${detail})`);
    this.name = 'MeetingAssociationError';
  }
}

export interface MeetingAssociationArgs {
  readonly tenant_id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
}

@Injectable()
export class MeetingAssociationValidator {
  constructor(
    private readonly talents: TalentRecordRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly pipelines: PipelineRepository,
  ) {}

  /**
   * Tenant ownership only: both records must belong to the caller's tenant. Used by
   * the create-link-only path to close its cross-tenant gap without changing its
   * no-association behavior (C-4). Fail-closed.
   */
  async assertTenantOwnership(args: MeetingAssociationArgs): Promise<void> {
    const contacts = await this.talents.findContactByIds(args.tenant_id, [args.talent_record_id]);
    if (!contacts.has(args.talent_record_id)) {
      throw new MeetingAssociationError('talent_not_in_tenant', args.talent_record_id);
    }
    const req = await this.requisitions.findStatusById({
      tenant_id: args.tenant_id,
      id: args.requisition_id,
    });
    if (req === null) {
      throw new MeetingAssociationError('requisition_not_in_tenant', args.requisition_id);
    }
  }

  /**
   * Full recruiting-association validation: tenant ownership PLUS a LIVE pipeline
   * episode linking this Talent to this Requisition. Used by the scheduling path,
   * where a recruiter meeting asserts a real recruiting relationship. Fail-closed.
   */
  async assertRecruitingAssociation(args: MeetingAssociationArgs): Promise<void> {
    await this.assertTenantOwnership(args);
    const episode = await this.pipelines.findLiveEpisode({
      tenant_id: args.tenant_id,
      talent_record_id: args.talent_record_id,
      requisition_id: args.requisition_id,
    });
    if (episode === null) {
      throw new MeetingAssociationError(
        'association_invalid',
        `${args.talent_record_id}@${args.requisition_id}`,
      );
    }
  }
}
