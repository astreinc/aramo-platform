import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';

// Repository for the sourced_talent L1 staging store (Fix-Slice-1). The Prisma
// boundary for the raw per-arrival landing table. UUID v7 PKs are generated
// app-side (Postgres 17 has no native uuidv7(); identity-index / talent-trust /
// canonicalization precedent).
//
// ATI-SEP-1 T10 WP2 — the ATS-local sourcing store: canonicalize resolves every
// ingestion arrival to a row here, the sourcing pool reads it, and promotion
// mints a TalentRecord from it. A recorded arrival is, to the rest of the
// platform, unconsented/unverified until it passes the promotion front door.

export interface SourcedTalentRow {
  id: string;
  tenant_id: string;
  source_channel: string;
  external_source_id: string;
  // Normalized contact material the arrival carries (nullable — NULL when the
  // caller supplied none). Reads expose exactly what the schema holds.
  normalized_email: string | null;
  normalized_phone: string | null;
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
  // SRC-1 PR-1 (R8) — optional normalized contact material. The caller MUST
  // supply these ALREADY normalized via `normalizeEmail` / `normalizePhone`
  // from `@aramo/common` (libs/common/src/lib/util/…) — NOT the `@aramo/identity`
  // twin at libs/identity/src/lib/util/email-domain.ts. The repository writes
  // them verbatim at INSERT only (never UPDATE — the immutability trigger
  // stands); undefined → the column stays NULL.
  normalized_email?: string;
  normalized_phone?: string;
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
          // SRC-1 PR-1 (R8): written at INSERT only. undefined → NULL column.
          normalized_email: input.normalized_email,
          normalized_phone: input.normalized_phone,
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

  /**
   * ATI-SEP-1 T10 WP2 — the arrival an ingestion payload already landed as. The
   * SRC-1 writers (Indeed apply webhook, manual capture) record the payload id in
   * provenance.ingestion_payload_id; canonicalize reuses that arrival instead of
   * minting a second one for the same payload. Tenant-scoped.
   */
  async findByIngestionPayloadId(
    tenantId: string,
    payloadId: string,
  ): Promise<SourcedTalentRow | null> {
    const row = await this.prisma.sourcedTalent.findFirst({
      where: {
        tenant_id: tenantId,
        provenance: { path: ['ingestion_payload_id'], equals: payloadId },
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return (row as SourcedTalentRow | null) ?? null;
  }

  /** ATI-SEP-1 T10 WP2 — tenant-scoped batch read by id (pool / advisory display). */
  async findByIds(tenantId: string, ids: readonly string[]): Promise<SourcedTalentRow[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.sourcedTalent.findMany({
      where: { tenant_id: tenantId, id: { in: [...ids] } },
    });
    return rows as SourcedTalentRow[];
  }

  /**
   * ATI-SEP-1 T10 WP2 — the sourcing pool's keyset scan: a tenant's arrivals,
   * oldest first, strictly after the (created_at, id) cursor. The caller filters
   * out the arrivals already linked to a TalentRecord (a separate schema).
   */
  async listByTenantKeyset(input: {
    tenant_id: string;
    limit: number;
    cursor: { created_at: Date; id: string } | null;
  }): Promise<SourcedTalentRow[]> {
    const c = input.cursor;
    const rows = await this.prisma.sourcedTalent.findMany({
      where: {
        tenant_id: input.tenant_id,
        ...(c === null
          ? {}
          : {
              OR: [
                { created_at: { gt: c.created_at } },
                { created_at: c.created_at, id: { gt: c.id } },
              ],
            }),
      },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
      take: input.limit,
    });
    return rows as SourcedTalentRow[];
  }

  /**
   * ATI-SEP-1 T10 WP2 — the duplicate detector's arrival leg: a tenant's arrivals
   * whose normalized email equals `email` OR whose normalized phone is one of
   * `phones` (the caller passes every equivalent digit form). Tenant-scoped; an
   * empty key set returns [].
   */
  async findByNormalizedContact(input: {
    tenant_id: string;
    email?: string | null;
    phones?: readonly string[];
  }): Promise<SourcedTalentRow[]> {
    const or: Array<Record<string, unknown>> = [];
    if (input.email !== undefined && input.email !== null && input.email !== '') {
      or.push({ normalized_email: input.email });
    }
    if (input.phones !== undefined && input.phones.length > 0) {
      or.push({ normalized_phone: { in: [...input.phones] } });
    }
    if (or.length === 0) return [];
    const rows = await this.prisma.sourcedTalent.findMany({
      where: { tenant_id: input.tenant_id, OR: or as never },
      orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
    });
    return rows as SourcedTalentRow[];
  }
}
