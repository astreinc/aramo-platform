import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AuthContext, JwtAuthGuard, type AuthContextType } from '@aramo/auth';
import { RequireScopes, RolesGuard } from '@aramo/authorization';
import { EntitlementGuard, RequireCapability } from '@aramo/entitlement';
import { IdentityService, type AssignableUserView } from '@aramo/identity';
import { UserClientAssignmentRepository } from '@aramo/company';

// §5 Auth-Hardening D4 — AssignableUsersController (the recruiter assignable
// roster; GET /v1/tenant/assignable-users).
//
// Lives in apps/api (NOT libs/identity) because it is a CROSS-SCHEMA
// composition: the roster joins identity (active membership + role) with the
// company schema's user↔client mapping (company.UserClientAssignment).
// libs/identity must not import the company schema (Architecture §7.3 / Nx
// boundary), so the composition is wired at the application boundary — the
// same placement rationale as TenantSettingsController. The identity half is
// exposed via IdentityService; the company half via UserClientAssignmentRepository
// (both already in the apps/api module graph).
//
// TWO modes (one param-gated endpoint):
//   • NO company_id → the BROAD roster: all ACTIVE tenant members. This serves
//     the non-requisition pickers (company-assign — which CREATES the mapping
//     so cannot self-filter; team-create / team-member; org-edge).
//   • company_id=X → the CLIENT-FILTERED roster (the requisition-assignment
//     picker, which passes the requisition's company_id): ACTIVE members who
//     are BOTH mapped to client X (UserClientAssignment) AND hold a REQ-CARRYING
//     role (Recruiter / Recruiter Lead). "Active req-carrying users mapped to
//     this client", not "active users in tenant". Cross-client no-leak: the
//     mapped-id set is scoped to (tenant_id, company_id), so a recruiter
//     picking for client A never sees client B's roster.
//
// DATA: { items: AssignableUserView[] } — user_id + display_name ONLY (the
// least-data projection; never the admin TenantUserView).
//
// SCOPE: tenant:user:read:assignable gates the CALLER (the 9 work-assigning
// roles). The req-carrying role narrowing is a CONTENT filter on who APPEARS in
// the client-filtered roster — orthogonal to the caller gate (a manager/AM can
// call the picker to assign a recruiter).
//
// SCOPING: tenant_id is from authContext (NEVER a param) — cross-tenant
// impossible. R10: the roster is a plain alphabetical list of people; the order
// carries no match/fit/quality verdict.
//
// PATH: /v1/tenant/assignable-users — a sibling of /v1/tenant/users, kept OFF
// the admin controller's /v1/tenant/users/:user_id param space so the literal
// segment is never captured as a :user_id (no cross-controller route-order
// fragility).

// The roster CONTENT filter for the requisition picker: the req-carrying roles
// (Lead ruling). Recruiter + Recruiter Lead carry requisitions; the broader
// work-assigning tier (managers / AM / sourcer / back-office / delivery) does
// NOT appear in a req's assignable roster.
const REQ_CARRYING_ROLE_KEYS = ['recruiter', 'lead_recruiter'] as const;

@Controller('v1/tenant/assignable-users')
@UseGuards(JwtAuthGuard, EntitlementGuard, RolesGuard)
@RequireCapability('core')
export class AssignableUsersController {
  constructor(
    private readonly identity: IdentityService,
    private readonly clientAssignments: UserClientAssignmentRepository,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequireScopes('tenant:user:read:assignable')
  async list(
    @AuthContext() authContext: AuthContextType,
    @Query('company_id') companyId?: string,
  ): Promise<{ items: AssignableUserView[] }> {
    if (companyId === undefined || companyId.length === 0) {
      const items = await this.identity.listAssignableTenantUsers(
        authContext.tenant_id,
      );
      return { items };
    }
    // Client-filtered (requisition picker): the user_ids mapped to this client
    // (tenant-scoped), intersected with active req-carrying members.
    const mapped = await this.clientAssignments.findByCompany({
      tenant_id: authContext.tenant_id,
      company_id: companyId,
    });
    const items = await this.identity.listAssignableTenantUsersByIdsAndRoles({
      tenant_id: authContext.tenant_id,
      user_ids: mapped.map((m) => m.user_id),
      role_keys: REQ_CARRYING_ROLE_KEYS,
    });
    return { items };
  }
}
