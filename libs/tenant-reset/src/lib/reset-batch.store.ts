import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

import { PrismaService } from './prisma/prisma.service.js';
import type {
  RecordResetBatchInput,
  ResetBatch,
  RowsByEntity,
} from './reset-batch.js';

// ResetBatchStore — the APPEND-ONLY write API for the tenant-reset
// administrative record (Track-0 §2.1). A ResetBatch is history: what
// was authorised, archived, and destroyed, and by whom.
//
// Append-only by construction: this store exposes `record` (the sole
// write path) plus reads — there is NO update method and NO delete
// method (asserted by test per §6). One append captures the whole
// outcome (started_at + completed_at + result are all known at record
// time), so no row is ever mutated.
//
// @Injectable so a consumer can wire it via DI; Track-0 ships the CLI
// (apps/api) that constructs it directly. Mirrors the
// RequisitionLifecycleEventStore append-only pattern (PR-0c).

/** The re-run refusal reads (§4). */
export interface CompletedRealRun {
  readonly id: string;
  readonly approved_by: string;
  readonly completed_at: Date | null;
  readonly execution_commit: string;
}

interface BatchRow {
  id: string;
  tenant_id: string;
  reason: string;
  approved_by: string;
  started_at: Date;
  completed_at: Date | null;
  archive_location: string | null;
  archive_checksum: string | null;
  rows_by_entity: unknown;
  execution_commit: string;
  dry_run: boolean;
  result: string;
  created_at: Date;
}

@Injectable()
export class ResetBatchStore {
  constructor(private readonly prisma: PrismaService) {}

  private static toBatch(row: BatchRow): ResetBatch {
    return {
      id: row.id,
      tenant_id: row.tenant_id,
      reason: row.reason,
      approved_by: row.approved_by,
      started_at: row.started_at,
      completed_at: row.completed_at,
      archive_location: row.archive_location,
      archive_checksum: row.archive_checksum,
      rows_by_entity: row.rows_by_entity as RowsByEntity,
      execution_commit: row.execution_commit,
      dry_run: row.dry_run,
      result: row.result as ResetBatch['result'],
      created_at: row.created_at,
    };
  }

  /** Append one ResetBatch. The only write path — history, never mutated. */
  async record(input: RecordResetBatchInput): Promise<ResetBatch> {
    const row = (await this.prisma.resetBatch.create({
      data: {
        id: uuidv7(),
        tenant_id: input.tenant_id,
        reason: input.reason,
        approved_by: input.approved_by,
        started_at: input.started_at,
        completed_at: input.completed_at,
        archive_location: input.archive_location,
        archive_checksum: input.archive_checksum,
        rows_by_entity: input.rows_by_entity as unknown as object,
        execution_commit: input.execution_commit,
        dry_run: input.dry_run,
        result: input.result,
      },
    })) as BatchRow;
    return ResetBatchStore.toBatch(row);
  }

  /** Read one batch by id (tenant-scoped), or null. */
  async getById(tenantId: string, id: string): Promise<ResetBatch | null> {
    const row = (await this.prisma.resetBatch.findFirst({
      where: { tenant_id: tenantId, id },
    })) as BatchRow | null;
    return row === null ? null : ResetBatchStore.toBatch(row);
  }

  /** All batches for a tenant, newest first. */
  async listByTenant(tenantId: string): Promise<ResetBatch[]> {
    const rows = (await this.prisma.resetBatch.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
    })) as BatchRow[];
    return rows.map((r) => ResetBatchStore.toBatch(r));
  }

  /**
   * The most recent COMPLETED non-dry-run batch for the tenant, or null.
   * Drives the re-run refusal (§4): a completed real run blocks another
   * until explicitly overridden with a new approval.
   */
  async findCompletedRealRun(tenantId: string): Promise<CompletedRealRun | null> {
    const row = (await this.prisma.resetBatch.findFirst({
      where: { tenant_id: tenantId, dry_run: false, result: 'COMPLETED' },
      orderBy: { created_at: 'desc' },
    })) as BatchRow | null;
    return row === null
      ? null
      : {
          id: row.id,
          approved_by: row.approved_by,
          completed_at: row.completed_at,
          execution_commit: row.execution_commit,
        };
  }
}
