import { Injectable } from '@nestjs/common';
import { AramoError } from '@aramo/common';

import { IdentityAuditService } from './audit/identity-audit.service.js';
import {
  TeamRepository,
  type TeamMembershipRow,
  type TeamRow,
} from './team.repository.js';

// AUTHZ-D4a — TeamService (Axis-2 account-ownership pods).
//
// Manages the identity-side of the pod substrate: Team creation +
// TeamMembership add/remove. The company-side join (TeamClientOwnership)
// is managed by libs/company per Option A schema placement.
//
// AM-anchor (Lead Gate-5 ruling 3): one AM per pod via owner_user_id.
// Co-AMs are a future amendment.
@Injectable()
export class TeamService {
  constructor(
    private readonly repo: TeamRepository,
    private readonly audit: IdentityAuditService,
  ) {}

  async createTeam(args: {
    tenant_id: string;
    name: string;
    owner_user_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<TeamRow> {
    const existing = await this.repo.findTeamByName({
      tenant_id: args.tenant_id,
      name: args.name,
    });
    if (existing !== null) {
      throw new AramoError(
        'VALIDATION_ERROR',
        'A team with this name already exists in the tenant',
        400,
        {
          requestId: args.request_id,
          details: { name: args.name, existing_team_id: existing.id },
        },
      );
    }
    const row = await this.repo.createTeam({
      tenant_id: args.tenant_id,
      name: args.name,
      owner_user_id: args.owner_user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.team.created',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: row.id,
      payload: { name: row.name, owner_user_id: row.owner_user_id },
    });
    return row;
  }

  async addMembership(args: {
    tenant_id: string;
    team_id: string;
    user_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<TeamMembershipRow> {
    const team = await this.repo.findTeamById({
      tenant_id: args.tenant_id,
      id: args.team_id,
    });
    if (team === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Team not found in tenant',
        404,
        { requestId: args.request_id, details: { team_id: args.team_id } },
      );
    }
    const existing = await this.repo.findMembership({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      user_id: args.user_id,
    });
    if (existing !== null) return existing;

    const row = await this.repo.addMembership({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      user_id: args.user_id,
      added_by_id: args.actor_user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.team.membership.added',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: row.id,
      payload: { team_id: args.team_id, user_id: args.user_id },
    });
    return row;
  }

  async removeMembership(args: {
    tenant_id: string;
    team_id: string;
    user_id: string;
    actor_user_id: string;
    request_id: string;
  }): Promise<void> {
    const existing = await this.repo.findMembership({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      user_id: args.user_id,
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Team membership not found in tenant',
        404,
        {
          requestId: args.request_id,
          details: { team_id: args.team_id, user_id: args.user_id },
        },
      );
    }
    await this.repo.removeMembership({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
      user_id: args.user_id,
    });
    await this.audit.writeEvent({
      event_type: 'identity.team.membership.removed',
      actor_type: 'user',
      actor_id: args.actor_user_id,
      tenant_id: args.tenant_id,
      subject_id: existing.id,
      payload: { team_id: args.team_id, user_id: args.user_id },
    });
  }
}
