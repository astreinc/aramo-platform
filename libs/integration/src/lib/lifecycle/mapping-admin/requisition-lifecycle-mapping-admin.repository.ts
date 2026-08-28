import { Injectable } from '@nestjs/common';

import { PrismaService } from '../../prisma/prisma.service.js';

import { MAPPING_SET_STATUS } from './mapping-admin.domain.js';

// L1-D3-A (R1) — data-access seam for the versioned mapping-set administration.
// Pure persistence: no policy, no requisition write, no HTTP. Draft-only-mutation
// and the one-active invariant are enforced at the SERVICE boundary + the DB
// (partial unique index + CHECK); this repository is the mechanism.

/** A mapping-set row as persisted (dates as Date; mapped to ISO in the service). */
export interface MappingSetRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly connection_id: string;
  readonly version: number;
  readonly status: string;
  readonly created_at: Date;
  readonly created_by: string;
  readonly activated_at: Date | null;
  readonly activated_by: string | null;
  readonly supersedes_set_id: string | null;
}

/** A mapping row as persisted. */
export interface MappingRow {
  readonly id: string;
  readonly provider_state: string;
  readonly disposition: string;
  readonly mapped_action: string | null;
  readonly authority_mode: string;
}

/** One draft row to persist (mapped_action null iff IGNORE). */
export interface PersistDraftRow {
  readonly provider_state: string;
  readonly disposition: string;
  readonly mapped_action: string | null;
}

/** Thrown when the one-active partial unique index rejects a concurrent activate. */
export class ActiveSetConflictError extends Error {
  constructor() {
    super('another active mapping set already exists for this connection');
    this.name = 'ActiveSetConflictError';
  }
}

const ONE_ACTIVE_INDEX = 'RequisitionLifecycleMappingSet_one_active_per_connection_uidx';

@Injectable()
export class RequisitionLifecycleMappingAdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** All sets for a connection, newest version first (history + active + drafts). */
  async listSets(tenantId: string, connectionId: string): Promise<MappingSetRow[]> {
    return (await this.prisma.requisitionLifecycleMappingSet.findMany({
      where: { tenant_id: tenantId, connection_id: connectionId },
      orderBy: { version: 'desc' },
    })) as MappingSetRow[];
  }

  /** One set by (tenant, connection, version), or null. */
  async findSetByVersion(
    tenantId: string,
    connectionId: string,
    version: number,
  ): Promise<MappingSetRow | null> {
    const rows = (await this.prisma.requisitionLifecycleMappingSet.findMany({
      where: { tenant_id: tenantId, connection_id: connectionId, version },
      take: 1,
    })) as MappingSetRow[];
    return rows[0] ?? null;
  }

  /** The single 'active' set for a connection, or null. */
  async findActiveSet(tenantId: string, connectionId: string): Promise<MappingSetRow | null> {
    const rows = (await this.prisma.requisitionLifecycleMappingSet.findMany({
      where: { tenant_id: tenantId, connection_id: connectionId, status: MAPPING_SET_STATUS.ACTIVE },
      take: 1,
    })) as MappingSetRow[];
    return rows[0] ?? null;
  }

  /** The highest version authored for a connection (0 if none). */
  async maxVersion(tenantId: string, connectionId: string): Promise<number> {
    const agg = await this.prisma.requisitionLifecycleMappingSet.aggregate({
      where: { tenant_id: tenantId, connection_id: connectionId },
      _max: { version: true },
    });
    return agg._max.version ?? 0;
  }

  /** The mapping rows of a set (empty for an empty draft). */
  async rowsForSet(setId: string): Promise<MappingRow[]> {
    return (await this.prisma.requisitionLifecycleMapping.findMany({
      where: { mapping_set_id: setId },
      orderBy: { provider_state: 'asc' },
      select: {
        id: true,
        provider_state: true,
        disposition: true,
        mapped_action: true,
        authority_mode: true,
      },
    })) as MappingRow[];
  }

  /** Create a new DRAFT set (+ optional seed rows) atomically. */
  async createDraftSet(args: {
    tenant_id: string;
    connection_id: string;
    version: number;
    created_by: string;
    rows: PersistDraftRow[];
  }): Promise<MappingSetRow> {
    return (await this.prisma.$transaction(async (tx) => {
      const set = (await tx.requisitionLifecycleMappingSet.create({
        data: {
          tenant_id: args.tenant_id,
          connection_id: args.connection_id,
          version: args.version,
          status: MAPPING_SET_STATUS.DRAFT,
          created_by: args.created_by,
        },
      })) as MappingSetRow;
      if (args.rows.length > 0) {
        await tx.requisitionLifecycleMapping.createMany({
          data: args.rows.map((r) => ({
            tenant_id: args.tenant_id,
            connection_id: args.connection_id,
            mapping_set_id: set.id,
            provider_state: r.provider_state,
            disposition: r.disposition,
            mapped_action: r.mapped_action,
            mapping_version: args.version,
          })),
        });
      }
      return set;
    })) as MappingSetRow;
  }

  /** Replace ALL rows of a DRAFT set (delete-then-insert) atomically. The caller
   * (service) guarantees the set is DRAFT before invoking this. */
  async replaceDraftRows(args: {
    tenant_id: string;
    connection_id: string;
    set_id: string;
    version: number;
    rows: PersistDraftRow[];
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.requisitionLifecycleMapping.deleteMany({ where: { mapping_set_id: args.set_id } });
      if (args.rows.length > 0) {
        await tx.requisitionLifecycleMapping.createMany({
          data: args.rows.map((r) => ({
            tenant_id: args.tenant_id,
            connection_id: args.connection_id,
            mapping_set_id: args.set_id,
            provider_state: r.provider_state,
            disposition: r.disposition,
            mapped_action: r.mapped_action,
            mapping_version: args.version,
          })),
        });
      }
    });
  }

  /**
   * ATOMIC activation: demote the current active set to 'historical' (if any),
   * THEN promote the draft to 'active'. The demote-then-promote order means the
   * one-active partial unique index never sees two active rows within the tx. A
   * concurrent activation that races loses at the index → ActiveSetConflictError.
   */
  async activate(args: {
    tenant_id: string;
    connection_id: string;
    draft_set_id: string;
    prior_active_id: string | null;
    activated_by: string;
  }): Promise<MappingSetRow> {
    try {
      return (await this.prisma.$transaction(async (tx) => {
        if (args.prior_active_id !== null) {
          await tx.requisitionLifecycleMappingSet.update({
            where: { id: args.prior_active_id },
            data: { status: MAPPING_SET_STATUS.HISTORICAL },
          });
        }
        return (await tx.requisitionLifecycleMappingSet.update({
          where: { id: args.draft_set_id },
          data: {
            status: MAPPING_SET_STATUS.ACTIVE,
            activated_at: new Date(),
            activated_by: args.activated_by,
            supersedes_set_id: args.prior_active_id,
          },
        })) as MappingSetRow;
      })) as MappingSetRow;
    } catch (err) {
      if (this.isOneActiveConflict(err)) {
        throw new ActiveSetConflictError();
      }
      throw err;
    }
  }

  /** Prisma-7 + PrismaPg partial-index P2002: the index name surfaces at
   * meta.driverAdapterError.cause.originalMessage / .constraint (NOT meta.target). */
  private isOneActiveConflict(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;
    const e = err as { code?: string; meta?: unknown };
    if (e.code !== 'P2002') return false;
    const meta = e.meta as
      | {
          target?: unknown;
          driverAdapterError?: { cause?: { originalMessage?: string; constraint?: { index?: string } } };
        }
      | undefined;
    const cause = meta?.driverAdapterError?.cause;
    if (cause?.constraint?.index === ONE_ACTIVE_INDEX) return true;
    if (typeof cause?.originalMessage === 'string' && cause.originalMessage.includes(ONE_ACTIVE_INDEX)) {
      return true;
    }
    // Defensive fallback: some driver shapes surface the index in meta.target.
    const target = meta?.target;
    if (typeof target === 'string' && target.includes(ONE_ACTIVE_INDEX)) return true;
    if (Array.isArray(target) && target.some((t) => typeof t === 'string' && t.includes(ONE_ACTIVE_INDEX))) {
      return true;
    }
    return false;
  }
}
