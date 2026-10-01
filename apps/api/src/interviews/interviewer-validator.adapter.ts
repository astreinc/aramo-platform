import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import type { InterviewerValidatorPort } from '@aramo/client-selection';
import { IdentityService } from '@aramo/identity';

// Slice B (Calendar/Interview §9) — the concrete interviewer tenant-user validator bound
// to the lib's INTERVIEWER_VALIDATOR port. It resolves the tenant's ACTIVE member roster
// (identity's assignable-users read) and refuses any interviewer id that is not a current
// tenant user (fail-closed, VALIDATION_ERROR 422). This is the ONLY place the interview
// schedule path crosses into identity — the client-selection lib stays L3-walled.
@Injectable()
export class IdentityInterviewerValidator implements InterviewerValidatorPort {
  constructor(private readonly identity: IdentityService) {}

  async assertValidTenantInterviewers(args: {
    tenant_id: string;
    interviewer_user_ids: readonly string[];
    requestId: string;
  }): Promise<void> {
    const ids = [...new Set(args.interviewer_user_ids)];
    if (ids.length === 0) return;
    const activeMembers = await this.identity.listAssignableTenantUsers(
      args.tenant_id,
    );
    const activeIds = new Set(activeMembers.map((u) => u.user_id));
    const invalid = ids.filter((id) => !activeIds.has(id));
    if (invalid.length > 0) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'One or more selected interviewers are not current users of this tenant',
        422,
        {
          requestId: args.requestId,
          details: { field: 'interviewer_user_ids', invalid_interviewer_user_ids: invalid },
        },
      );
    }
  }
}
