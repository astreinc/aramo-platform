import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type { ShadowObservation } from './canonical-match-shadow.taxonomy.js';

// SKILL-TAX-1E — persistence for the append-only DARK shadow-observation table.
// INSERT-ONLY surface (no update/delete method; the migration's immutability
// trigger enforces append-only at the DB). Reads are aggregate coverage only —
// this table never feeds a request response.

export interface PersistObservationsInput {
  tenant_id: string;
  examination_id: string;
  talent_id: string;
  golden_profile_id: string;
  requisition_id: string;
  observations: readonly ShadowObservation[];
}

@Injectable()
export class CanonicalMatchShadowRepository {
  constructor(private readonly prisma: PrismaService) {}

  // Append the observations for one examination. Idempotency is NOT required
  // (each examine mint is a distinct observation event); ids are fresh uuidv7.
  async persistObservations(input: PersistObservationsInput): Promise<number> {
    if (input.observations.length === 0) return 0;
    const { count } = await this.prisma.canonicalMatchShadowObservation.createMany({
      data: input.observations.map((o) => ({
        id: uuidv7(),
        tenant_id: input.tenant_id,
        examination_id: input.examination_id,
        talent_id: input.talent_id,
        golden_profile_id: input.golden_profile_id,
        requisition_id: input.requisition_id,
        match_class: o.match_class,
        requisition_surface_form: o.requisition_surface_form,
        requisition_canonical_skill_id: o.requisition_canonical_skill_id,
        talent_canonical_skill_id: o.talent_canonical_skill_id,
      })),
    });
    return count;
  }

  // Coverage telemetry — count of observations grouped by match_class (queryable,
  // no new table). Tenant-scoped when a tenant is given; global otherwise.
  async coverageByClass(tenantId?: string): Promise<Record<string, number>> {
    const rows = await this.prisma.canonicalMatchShadowObservation.groupBy({
      by: ['match_class'],
      ...(tenantId !== undefined ? { where: { tenant_id: tenantId } } : {}),
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.match_class] = r._count._all;
    return out;
  }
}
