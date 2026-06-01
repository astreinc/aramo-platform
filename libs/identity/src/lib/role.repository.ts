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
