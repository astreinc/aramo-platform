import { Inject, Injectable } from '@nestjs/common';
import { type AramoLogger } from '@aramo/common';

import { PrismaService } from './prisma/prisma.service.js';
import {
  isRequisitionAnalysisContextV1,
  type RequisitionAnalysisContextV1,
} from './dto/requisition-analysis-context.js';
import type { RequisitionAnalysisContextSnapshotView } from './dto/requisition-analysis-context-snapshot.view.js';

// CI-B2 — repository for RequisitionAnalysisContextSnapshot.
//
// Surface scope (CLOSED): createSnapshot (create-only) + two tenant-
// scoped reads. There is deliberately NO update / upsert / delete path —
// the snapshot is immutable (directive §10). The database-layer whole-
// row BEFORE UPDATE trigger
// (conversation_intelligence.reject_requisition_analysis_context_snapshot_update)
// is the belt-and-suspenders enforcement; this surface is the primary
// application-layer guarantee.
//
// Every read leads with tenant_id (conceal convention) — a cross-tenant
// id simply is not found.

export interface CreateRequisitionAnalysisContextSnapshotInput {
  id: string;
  tenant_id: string;
  requisition_id: string;
  source_requisition_version: number;
  golden_profile_id: string | null;
  snapshot_schema_version: string;
  context: RequisitionAnalysisContextV1;
  captured_at: Date;
}

interface RequisitionAnalysisContextSnapshotRow {
  id: string;
  tenant_id: string;
  requisition_id: string;
  source_requisition_version: number;
  golden_profile_id: string | null;
  snapshot_schema_version: string;
  context: unknown;
  captured_at: Date;
  created_at: Date;
}

function projectView(
  row: RequisitionAnalysisContextSnapshotRow,
): RequisitionAnalysisContextSnapshotView {
  // Fail closed on a malformed / wrong-version payload rather than hand a
  // caller an untyped blob.
  if (!isRequisitionAnalysisContextV1(row.context)) {
    throw new Error(
      `RequisitionAnalysisContextSnapshot ${row.id} carries an unrecognized context payload`,
    );
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    requisition_id: row.requisition_id,
    source_requisition_version: row.source_requisition_version,
    golden_profile_id: row.golden_profile_id,
    snapshot_schema_version: row.snapshot_schema_version,
    context: row.context,
    captured_at: row.captured_at,
    created_at: row.created_at,
  };
}

@Injectable()
export class RequisitionAnalysisContextSnapshotRepository {
  constructor(
    private readonly prisma: PrismaService,
    @Inject('RequisitionAnalysisContextSnapshotRepositoryLogger')
    private readonly logger: AramoLogger,
  ) {}

  async createSnapshot(
    input: CreateRequisitionAnalysisContextSnapshotInput,
  ): Promise<RequisitionAnalysisContextSnapshotView> {
    const startedAt = Date.now();
    this.logger.log({
      event: 'requisition_analysis_context_snapshot.create_started',
      tenant_id: input.tenant_id,
      requisition_id: input.requisition_id,
      snapshot_id: input.id,
      source_requisition_version: input.source_requisition_version,
    });
    const created = await this.prisma.requisitionAnalysisContextSnapshot.create(
      {
        data: {
          id: input.id,
          tenant_id: input.tenant_id,
          requisition_id: input.requisition_id,
          source_requisition_version: input.source_requisition_version,
          golden_profile_id: input.golden_profile_id,
          snapshot_schema_version: input.snapshot_schema_version,
          context: input.context as never,
          captured_at: input.captured_at,
        },
      },
    );
    const view = projectView(
      created as RequisitionAnalysisContextSnapshotRow,
    );
    this.logger.log({
      event: 'requisition_analysis_context_snapshot.created',
      tenant_id: view.tenant_id,
      requisition_id: view.requisition_id,
      snapshot_id: view.id,
      latency_ms: Date.now() - startedAt,
    });
    return view;
  }

  async findById(
    tenant_id: string,
    id: string,
  ): Promise<RequisitionAnalysisContextSnapshotView | null> {
    const row = await this.prisma.requisitionAnalysisContextSnapshot.findFirst({
      where: { tenant_id, id },
    });
    return row === null
      ? null
      : projectView(row as RequisitionAnalysisContextSnapshotRow);
  }

  async findByRequisitionId(
    tenant_id: string,
    requisition_id: string,
  ): Promise<RequisitionAnalysisContextSnapshotView[]> {
    const rows = await this.prisma.requisitionAnalysisContextSnapshot.findMany({
      where: { tenant_id, requisition_id },
      orderBy: [{ captured_at: 'desc' }, { id: 'asc' }],
    });
    return (rows as RequisitionAnalysisContextSnapshotRow[]).map((r) =>
      projectView(r),
    );
  }
}
