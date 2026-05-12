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
}
