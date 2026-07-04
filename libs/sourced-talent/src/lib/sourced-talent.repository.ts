import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the sourced_talent L1 staging store (Fix-Slice-1). The Prisma
// boundary for the raw per-arrival landing table. UUID v7 PKs are generated
// app-side (Postgres 17 has no native uuidv7(); identity-index / talent-trust /
// canonicalization precedent).
//
// SCOPE (Fix-Slice-1): the record/find primitives ONLY. No promotion/resolver
// wiring (that is fix-slice-2). A recorded arrival is, to the rest of the
// platform, unconsented/unverified/unevidenced until it passes the promotion
// front door.

export interface SourcedTalentRow {
  id: string;
  tenant_id: string;
  source_channel: string;
  external_source_id: string;
  provenance: unknown;
  legal_basis: unknown;
  arrived_at: Date;
  created_at: Date;
}

export interface RecordArrivalInput {
  tenant_id: string;
  source_channel: string;
  external_source_id: string;
  provenance: unknown;
  legal_basis: unknown;
  // The channel-side arrival time (caller-supplied — the sourcing pull time).
  arrived_at: Date;
}

@Injectable()
export class SourcedTalentRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a raw channel arrival, idempotently (the dedup memory, §4). One row
   * per (tenant, source_channel, external_source_id): a re-pull of the same
   * channel profile resolves to the SAME arrival — returns the existing row,
   * never duplicates. Race-safe: if a concurrent caller wins the create (the
   * @@unique rejects the loser), the loser re-reads and returns the winner's
   * row. The arrival is immutable once written (the DB trigger rejects UPDATE).
   */
  async recordArrival(input: RecordArrivalInput): Promise<SourcedTalentRow> {
    const existing = await this.findArrival(
      input.tenant_id,
      input.source_channel,
      input.external_source_id,
    );
    if (existing !== null) return existing;
    try {
      const row = await this.prisma.sourcedTalent.create({
        data: {
          id: uuidv7(),
          tenant_id: input.tenant_id,
          source_channel: input.source_channel,
          external_source_id: input.external_source_id,
          provenance: input.provenance as never,
          legal_basis: input.legal_basis as never,
          arrived_at: input.arrived_at,
        },
      });
      return row as SourcedTalentRow;
    } catch (err) {
      // Lost the create race (unique-violation on the dedup key) → the winner's
      // arrival now exists; re-read it. Any other error propagates.
      const afterRace = await this.findArrival(
        input.tenant_id,
        input.source_channel,
        input.external_source_id,
      );
      if (afterRace !== null) return afterRace;
      throw err;
    }
  }

  /**
   * Resolve an arrival by its dedup key (tenant, channel, external id). Returns
   * the row or null (an unseen arrival).
   */
  async findArrival(
    tenantId: string,
    sourceChannel: string,
    externalSourceId: string,
  ): Promise<SourcedTalentRow | null> {
    const row = await this.prisma.sourcedTalent.findUnique({
      where: {
        tenant_id_source_channel_external_source_id: {
          tenant_id: tenantId,
          source_channel: sourceChannel,
          external_source_id: externalSourceId,
        },
      },
    });
    return (row as SourcedTalentRow | null) ?? null;
  }

  /**
   * Existence/identity lookup by arrival id — the id a SOURCED_TALENT
   * ResolutionSubjectRef points at (UUID-only, no FK). Returns the row or null.
   */
  async findById(id: string): Promise<SourcedTalentRow | null> {
    const row = await this.prisma.sourcedTalent.findUnique({ where: { id } });
    return (row as SourcedTalentRow | null) ?? null;
  }
}
