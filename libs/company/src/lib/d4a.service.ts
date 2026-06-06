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

  // Settings S5-BE2 — list a company's user assignments.
  //
  // READING A (PO-ratified): scope-gated tenant-wide. The company:assign
  // holder lists every assignment for the company (parity with
  // POST/DELETE /v1/companies/:companyId/assignments which target any
  // company in the tenant — no D4b visible_client_ids narrowing on the
  // write side, so the read MUST match the write authority).
  //
  // Precheck: company exists in tenant → 404 if not (mirrors
  // assignUserToClient's existence check; the existence-non-leak rule
  // per S5-BE1). NO resolver call (Reading A).
  async listAssignmentsForCompany(args: {
    tenant_id: string;
    company_id: string;
    request_id: string;
  }): Promise<UserClientAssignmentRow[]> {
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
    return this.assignments.findByCompany({
      tenant_id: args.tenant_id,
      company_id: args.company_id,
    });
  }

  // Settings S5-BE2 — list a team's client ownerships.
  //
  // READING A: scope-gated tenant-wide. The team:manage holder lists
  // every team-client edge for the team. Parity with the mutates
  // (POST/DELETE /v1/teams/:teamId/clients accept any team_id in the
  // tenant; no D4b narrowing).
  //
  // NO team-existence precheck (the §7.3 cross-schema rule — Team lives
  // in identity, the existing addClientOwnership service explicitly
  // notes "D4a does not impose a cross-schema FK lookup here — that
  // would re-introduce the cross-schema coupling §7.3 forbids"). The
  // tenant_id WHERE on TeamClientOwnership is sufficient — a cross-
  // tenant :teamId returns empty (no leak; indistinguishable from a
  // tenant-local team with no clients). NO resolver call.
  async listClientsForTeam(args: {
    tenant_id: string;
    team_id: string;
  }): Promise<TeamClientOwnershipRow[]> {
    return this.ownerships.findByTeam({
      tenant_id: args.tenant_id,
      team_id: args.team_id,
    });
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
