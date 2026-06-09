import { Injectable } from '@nestjs/common';
import { IdentityService } from '@aramo/identity';
import type { TaskAssigneeValidator } from '@aramo/task';

// Tasks backend — TaskAssigneeAdapter (live implementation of the
// TASK_ASSIGNEE_VALIDATOR port declared in libs/task).
//
// Validates an assignee is an ACTIVE within-tenant member via
// IdentityService.findMembership (the substrate behind GET /v1/tenant/users).
// The adapter is the only place libs/task (via its port) and libs/identity
// meet — both stay leaf-clean (libs/task has NO @aramo/identity import). The
// TenantCognitoAdapter / AuditFinancialsGateAdapter precedent.
@Injectable()
export class TaskAssigneeAdapter implements TaskAssigneeValidator {
  constructor(private readonly identity: IdentityService) {}

  async isActiveTenantMember(args: {
    tenant_id: string;
    user_id: string;
  }): Promise<boolean> {
    const membership = await this.identity.findMembership({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
    });
    return membership !== null && membership.is_active === true;
  }
}
