import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';

import { deriveCapacity, type CapacityProjection } from './capacity-derivation.js';

// Track 4 / T4-B — the placement-owned capacity projection (§4: placement OWNS
// capacity truth; consumers PULL via a declared consumer->placement edge).
// placement stays zero-outgoing-edge: `openings` is supplied BY the caller
// (never read from the requisition here), and no raw cross-schema SQL is used.
//
// Consumption authority is the UNION of two consuming populations (Track 7 / T7-P1
// §7/§10): ACTIVE ContractAssignment (Track 4, the contract path) and
// PermanentPlacement in a consuming guarantee state (GUARANTEE_ACTIVE or
// GUARANTEE_SATISFIED — a successfully-filled permanent seat keeps consuming; a
// fallen-off/remedy state does NOT, but those are T7-P2). This is the SINGLE
// canonical capacity edit-site — the union happens HERE, in the consuming count,
// and the pure `deriveCapacity` is UNCHANGED (§7). No second counter, no imperative
// decrement. Residual legacy STARTED placements with no materialised aggregate are
// NOT counted (completeness bound, §A3.2).
@Injectable()
export class CapacityProjectionRepository {
  constructor(private readonly prisma: PrismaService) {}

  // The PermanentPlacement consuming states (T7-P1 §10). A satisfied permanent
  // placement continues to consume its opening (the seat is filled). FELL_OFF and
  // the remedy states do NOT consume — they are absent in P1's enum.
  private static readonly PERMANENT_CONSUMING_STATES = ['GUARANTEE_ACTIVE', 'GUARANTEE_SATISFIED'] as const;

  // Count of authoritative consuming records for a requisition, tenant-scoped: the
  // ACTIVE ContractAssignment count PLUS the consuming-state PermanentPlacement
  // count (two count queries, unioned by addition — the clearest auditable form).
  async countActiveByRequisition(tenant_id: string, requisition_id: string): Promise<number> {
    const [contractCount, permanentCount] = await Promise.all([
      this.prisma.contractAssignment.count({
        where: { tenant_id, requisition_id, lifecycle_state: 'ACTIVE' },
      }),
      this.prisma.permanentPlacement.count({
        where: {
          tenant_id,
          requisition_id,
          lifecycle_state: { in: [...CapacityProjectionRepository.PERMANENT_CONSUMING_STATES] },
        },
      }),
    ]);
    return contractCount + permanentCount;
  }

  // Track 4 / T4-B2 — the SET-oriented consuming count. ONE grouped query PER
  // population (never N per-requisition reads in a loop — the ruling's reporting
  // rule), then the two maps are unioned by addition per requisition_id.
  // Requisitions with zero consuming records are ABSENT from the returned map;
  // callers treat a miss as 0 (deriveCapacity with consuming_count 0).
  async countActiveByRequisitionIds(
    tenant_id: string,
    requisition_ids: readonly string[],
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (requisition_ids.length === 0) return out;
    const ids = [...requisition_ids];
    const [contractGrouped, permanentGrouped] = await Promise.all([
      this.prisma.contractAssignment.groupBy({
        by: ['requisition_id'],
        where: { tenant_id, requisition_id: { in: ids }, lifecycle_state: 'ACTIVE' },
        _count: { _all: true },
      }),
      this.prisma.permanentPlacement.groupBy({
        by: ['requisition_id'],
        where: {
          tenant_id,
          requisition_id: { in: ids },
          lifecycle_state: { in: [...CapacityProjectionRepository.PERMANENT_CONSUMING_STATES] },
        },
        _count: { _all: true },
      }),
    ]);
    for (const g of contractGrouped) out.set(g.requisition_id, g._count._all);
    for (const g of permanentGrouped) out.set(g.requisition_id, (out.get(g.requisition_id) ?? 0) + g._count._all);
    return out;
  }

  // The full derived capacity for a requisition. `openings` is caller-supplied.
  async projectCapacity(tenant_id: string, requisition_id: string, openings: number): Promise<CapacityProjection> {
    const consuming_count = await this.countActiveByRequisition(tenant_id, requisition_id);
    return deriveCapacity({ openings, consuming_count });
  }
}
