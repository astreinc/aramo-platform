import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import { deriveCapacity, type CapacityProjection } from './capacity-derivation.js';

// Track 4 / T4-B — the placement-owned capacity projection (§4: placement OWNS
// capacity truth; consumers PULL via a declared consumer->placement edge).
// placement stays zero-outgoing-edge: `openings` is supplied BY the caller
// (never read from the requisition here), and no raw cross-schema SQL is used.
//
// Consumption authority is the ACTIVE ContractAssignment population. Residual
// legacy STARTED placements with no materialised assignment are NOT counted —
// coverage is bounded by the assignment population (completeness bound, §A3.2).
@Injectable()
export class CapacityProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Count of authoritative consuming assignments (ACTIVE ContractAssignment) for a
  // requisition, tenant-scoped.
  async countActiveByRequisition(tenant_id: string, requisition_id: string): Promise<number> {
    return this.prisma.contractAssignment.count({
      where: { tenant_id, requisition_id, lifecycle_state: 'ACTIVE' },
    });
  }

  // The full derived capacity for a requisition. `openings` is caller-supplied.
  async projectCapacity(tenant_id: string, requisition_id: string, openings: number): Promise<CapacityProjection> {
    const consuming_count = await this.countActiveByRequisition(tenant_id, requisition_id);
    return deriveCapacity({ openings, consuming_count });
  }
}
