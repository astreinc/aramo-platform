import { Injectable } from '@nestjs/common';

import type { TenantDto } from './dto/tenant.dto.js';
import { PrismaService } from './prisma/prisma.service.js';

// Repository for Tenant / Membership reads. Per §7 TenantService.getTenantsByUser,
// callers want tenants the user has an *active* membership in AND the tenant
// itself is active. Filtering happens database-side via the relation predicate.
@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActiveTenantsForUser(args: { user_id: string }): Promise<TenantDto[]> {
    const rows = await this.prisma.tenant.findMany({
      where: {
        is_active: true,
        memberships: {
          some: {
            user_id: args.user_id,
            is_active: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
    return rows.map(toTenantDto);
  }
}

type TenantRow = {
  id: string;
  name: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

function toTenantDto(row: TenantRow): TenantDto {
  return {
    id: row.id,
    name: row.name,
    is_active: row.is_active,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}
