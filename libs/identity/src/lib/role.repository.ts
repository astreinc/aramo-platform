import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for Role / Scope reads. Per §7 RoleService.getScopesByUserAndTenant,
// callers want the set of scope keys the user has via active role assignments
// on an active membership in the given tenant. Returns deduplicated scope keys.
@Injectable()
export class RoleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findScopeKeysForUserInTenant(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<string[]> {
    // Single query traverses Membership → UserTenantMembershipRole → Role → RoleScope → Scope.
    // Active filters applied at the membership and role levels (Membership.is_active,
    // Role.is_active). The directive does not require a separate Scope.is_active
    // gate (Scope has no is_active column in §5 schema).
    //
    // Site-agnostic resolver — preserved unchanged for pre-A1a callers.
    // Returns scopes from ALL active memberships in the tenant regardless
    // of site_id. New A1a callers that need site awareness use
    // findScopeKeysForUserInTenantAndSite below.
    const assignments = await this.prisma.userTenantMembershipRole.findMany({
      where: {
        membership: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
          is_active: true,
        },
        role: {
          is_active: true,
        },
      },
      include: {
        role: {
          include: {
            role_scopes: {
              include: { scope: true },
            },
          },
        },
      },
    });

    const keys = new Set<string>();
    for (const assignment of assignments) {
      for (const rs of assignment.role.role_scopes) {
        keys.add(rs.scope.key);
      }
    }
    return [...keys];
  }

  // PR-A1a-3 Ruling 1 (auto-stamp): returns the site_id of the user's
  // active membership in the tenant when that membership is site-scoped,
  // null otherwise (membership missing, inactive, or tenant-wide).
  //
  // The identity schema constrains memberships by @@unique([user_id,
  // tenant_id]), so a user has AT MOST one membership per tenant — the
  // ">1 site-scoped membership" disambiguation case from the directive
  // is structurally prevented. This makes the auto-stamp a single
  // deterministic read of (membership.site_id, membership.is_active).
  //
  // Used by auth-service session + refresh orchestrators at issuance
  // time to decide whether to stamp the JWT site_id claim. A stamped
  // site_id therefore ALWAYS corresponds to a real active membership
  // (Ruling 5 fail-closed).
  async findActiveMembershipSite(args: {
    user_id: string;
    tenant_id: string;
  }): Promise<string | null> {
    const row = await this.prisma.userTenantMembership.findUnique({
      where: {
        user_id_tenant_id: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
        },
      },
      select: { is_active: true, site_id: true },
    });
    if (row === null || row.is_active !== true) return null;
    return row.site_id;
  }

  // PR-A1a site-aware resolver (Ruling 4): returns the union of
  //   (a) tenant-wide membership scopes (site_id IS NULL), and
  //   (b) memberships whose site_id matches the provided site.
  // When site_id is undefined (tenant-wide auth), returns only (a) — a
  // user whose ONLY membership is a site-scoped one receives NO scopes
  // under a tenant-wide JWT. This is the fail-closed posture: site
  // authority does NOT leak to tenant-wide tokens.
  async findScopeKeysForUserInTenantAndSite(args: {
    user_id: string;
    tenant_id: string;
    site_id?: string;
  }): Promise<string[]> {
    const siteFilter =
      args.site_id === undefined
        ? { site_id: null }
        : { OR: [{ site_id: null }, { site_id: args.site_id }] };

    const assignments = await this.prisma.userTenantMembershipRole.findMany({
      where: {
        membership: {
          user_id: args.user_id,
          tenant_id: args.tenant_id,
          is_active: true,
          ...siteFilter,
        },
        role: {
          is_active: true,
        },
      },
      include: {
        role: {
          include: {
            role_scopes: {
              include: { scope: true },
            },
          },
        },
      },
    });

    const keys = new Set<string>();
    for (const assignment of assignments) {
      for (const rs of assignment.role.role_scopes) {
        keys.add(rs.scope.key);
      }
    }
    return [...keys];
  }
}
