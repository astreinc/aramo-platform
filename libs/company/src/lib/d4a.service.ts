import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { IdentityAuditService } from '@aramo/identity';

import { CompanyRepository } from './company.repository.js';
import {
  TeamClientOwnershipRepository,
  type TeamClientOwnershipRow,
} from './team-client-ownership.repository.js';
import {
  UserClientAssignmentRepository,
  type UserClientAssignmentRow,
} from './user-client-assignment.repository.js';

// AUTHZ-D4a — company-side mechanism service (the direct-assignment axis
// + the Axis-2 pod -> client linkage). Mirrors the RequisitionAssignment
// service pattern. Idempotent on both creates (Lead Gate-5 ruling 6 —
// silent no-op via composite-key findUnique check; no UPDATE).
//
// Audit emission: all D4a writes emit identity.* events via the cross-lib
// IdentityAuditService. The +9 EVENT_TYPES live in libs/identity's closed
// set; this service is the company-side emitter.
@Injectable()
export class D4aCompanyService {
  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly assignments: UserClientAssignmentRepository,
    private readonly ownerships: TeamClientOwnershipRepository,
    private readonly audit: IdentityAuditService,
  ) {}

  // --- Direct-assignment axis (company:assign) -----------------------------

  async assignUserToClient(args: {
    tenant_id: string;
    user_id: string;
    company_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<UserClientAssignmentRow> {
    // Cross-schema parent validation (Architecture §7.3 — the company-
    // logical resolution + tenant-scoped existence check).
    const company = await this.companyRepo.findById({
      tenant_id: args.tenant_id,
      id: args.company_id,
    });
    if (company === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        {
          requestId: args.request_id,
          details: { company_id: args.company_id },
        },
      );
    }
    // Idempotent re-assign — silent no-op (Lead Gate-5 ruling 6).
    const existing = await this.assignments.findByPair({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      company_id: args.company_id,
    });
    if (existing !== null) return existing;

    const row = await this.assignments.create({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      company_id: args.company_id,
      assigned_by_id: args.actor_user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.user_client_assignment.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: row.id,
      payload: { user_id: args.user_id, company_id: args.company_id },
    });
    return row;
  }

  async unassignUserFromClient(args: {
    tenant_id: string;
    user_id: string;
    company_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<void> {
    const existing = await this.assignments.findByPair({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      company_id: args.company_id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'User-client assignment not found in tenant',
        404,
        {
          requestId: args.request_id,
          details: {
            user_id: args.user_id,
            company_id: args.company_id,
          },
        },
      );
    }
    await this.assignments.deleteByPair({
      tenant_id: args.tenant_id,
      user_id: args.user_id,
      company_id: args.company_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.user_client_assignment.removed',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: existing.id,
      payload: { user_id: args.user_id, company_id: args.company_id },
    });
  }

  // --- Axis-2 client-ownership (team:manage, company-side) -----------------

  async addClientOwnership(args: {
    tenant_id: string;
    team_id: string;
    company_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<TeamClientOwnershipRow> {
    const company = await this.companyRepo.findById({
      tenant_id: args.tenant_id,
      id: args.company_id,
    });
    if (company === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Company not found in tenant',
        404,
        {
          requestId: args.request_id,
          details: { company_id: args.company_id },
        },
      );
    }
    // Note: team_id is a cross-schema logical reference; existence-check
    // of identity.Team is the caller's responsibility (the controller-side
    // mechanism flow validates the team exists before delegating here).
    // D4a does not impose a cross-schema FK lookup here — that would
    // re-introduce the cross-schema coupling §7.3 forbids.
    const existing = await this.ownerships.findByPair({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      company_id: args.company_id,
    });
    if (existing !== null) return existing;

    const row = await this.ownerships.create({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      company_id: args.company_id,
      assigned_by_id: args.actor_user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.team.client_ownership.added',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: row.id,
      payload: { team_id: args.team_id, company_id: args.company_id },
    });
    return row;
  }

  async removeClientOwnership(args: {
    tenant_id: string;
    team_id: string;
    company_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<void> {
    const existing = await this.ownerships.findByPair({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      company_id: args.company_id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Team-client ownership not found in tenant',
        404,
        {
          requestId: args.request_id,
          details: { team_id: args.team_id, company_id: args.company_id },
        },
      );
    }
    await this.ownerships.deleteByPair({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      company_id: args.company_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.team.client_ownership.removed',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: existing.id,
      payload: { team_id: args.team_id, company_id: args.company_id },
    });
  }
}
