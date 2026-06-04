import { Injectable } from '@nestjs/common';

import type { Capability } from './capability.js';
import { isCapability } from './capability.js';
import { PrismaService } from './prisma/prisma.service.js';

// EntitlementRepository — read surface for the EntitlementGuard +, since
// AUTHZ-2, the provisioning grant surface.
//
// Looks up the set of capabilities entitled to a tenant. Presence-as-
// entitled (no `enabled` flag at PR-A1b — see schema.prisma comment).
// Soft-disable can be added later via an `enabled` column without
// breaking the read shape.
//
// AUTHZ-2: grantCapabilities writes the (tenant_id, capability) rows the
// platform-tier TenantService.provisionTenant emits as the entitlement-tx
// step of the cross-schema saga (Cognito → identity-tx → entitlement-tx;
// Lead ruling 7 — soft-disable on entitlement failure rather than 2PC). The
// composite PK (@@id([tenant_id, capability])) makes the grant idempotent
// at the row level; the createMany skipDuplicates honors that.
@Injectable()
export class EntitlementRepository {
  constructor(private readonly prisma: PrismaService) {}

  async getCapabilities(tenantId: string): Promise<Set<Capability>> {
    const rows = await this.prisma.tenantEntitlement.findMany({
      where: { tenant_id: tenantId },
      select: { capability: true },
    });
    const result = new Set<Capability>();
    for (const row of rows) {
      if (isCapability(row.capability)) {
        result.add(row.capability);
      }
    }
    return result;
  }

  async grantCapabilities(args: {
    tenant_id: string;
    capabilities: readonly Capability[];
  }): Promise<void> {
    if (args.capabilities.length === 0) return;
    await this.prisma.tenantEntitlement.createMany({
      data: args.capabilities.map((capability) => ({
        tenant_id: args.tenant_id,
        capability,
      })),
      skipDuplicates: true,
    });
  }
}
