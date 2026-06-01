import { Injectable } from '@nestjs/common';

import type { Capability } from './capability.js';
import { isCapability } from './capability.js';
import { PrismaService } from './prisma/prisma.service.js';

// EntitlementRepository — read surface for the EntitlementGuard.
//
// Looks up the set of capabilities entitled to a tenant. Presence-as-
// entitled (no `enabled` flag at PR-A1b — see schema.prisma comment).
// Soft-disable can be added later via an `enabled` column without
// breaking the read shape.
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
}
