import { Injectable, Logger } from '@nestjs/common';
import { AramoError } from '@aramo/common';
import { insertActivityInTx } from '@aramo/activity';
import { recordUsage } from '@aramo/metering';

import type { PipelineView } from './dto/pipeline.view.js';
import type { PipelineStatusHistoryView } from './dto/pipeline-status-history.view.js';
import type { CreatePipelineRequestDto } from './dto/create-pipeline-request.dto.js';
import {
  canTransition,
  type PipelineStatus,
} from './pipeline-state.js';
import { PrismaService } from './prisma/prisma.service.js';

// PipelineRepository — write + read surface for Pipeline + the ENFORCED
// state machine transition (PR-A5a Gate 5).
//
// === The transition method (directive §3 — the heart of A5a) ===
//
// The five-step internal flow of `transition(...)`:
//   1. Read the current Pipeline.status from the DB (tenant-scoped).
//   2. No-op guard: `to_status === current` → return without DB write.
//      No PipelineStatusHistory row, no Activity row, no metering event.
//      (Directive §2 / Ruling 1: a no-op is a real "same state" semantic;
//      we do NOT pad history with self-loops.)
//   3. Legality check: `canTransition(current, to)` per the application-
//      layer state machine (libs/pipeline/src/lib/pipeline-state.ts).
//      Illegal → throw INVALID_PIPELINE_TRANSITION (422). No write.
//   4. Atomic 4-write `$transaction([...])` (directive §3 / Ruling 6 —
//      same-tx atomicity):
//        a. UPDATE Pipeline.status
//        b. INSERT PipelineStatusHistory (from / to / changed_by / note)
//        c. INSERT activity."Activity" (type=pipeline_status_change)
//           via insertActivityInTx — cross-schema $executeRaw composed
//           into the array (the recordUsage pattern, second application).
//        d. recordUsage(this.prisma, { event_type: 'pipeline.state_transition' })
//           — the first ATS-domain metered event (Ruling 4; the A1c
//           transactional guarantee, extended to pipeline).
//      All four writes commit together, or none does. The integration
//      spec asserts this structurally.
//   5. Return the updated PipelineView (the controller projects it).
//
// === PR-A5a/A5b boundary (Ruling 3) ===
//
// When `to === 'placed'`, the transition writes status + history +
// activity + metering EXACTLY as any other legal transition does — but
// DOES NOT touch the requisition.openings_available counter or any
// submittal row. The openings decrement and the submittal sync belong
// to PR-A5b; this repository never reads or writes requisition.* or
// submittal.* tables. The state-machine proof asserts this: post-
// transition-to-placed, requisition.Requisition.openings_available and
// the submittal."TalentSubmittalRecord" table are bit-for-bit identical
// to their pre-transition state.

interface PipelineRow {
  id: string;
  tenant_id: string;
  site_id: string | null;
  talent_record_id: string;
  requisition_id: string;
  status: PipelineStatus;
  created_at: Date;
  updated_at: Date;
}

interface PipelineStatusHistoryRow {
  id: string;
  tenant_id: string;
  pipeline_id: string;
  status_from: PipelineStatus;
  status_to: PipelineStatus;
  changed_by_id: string | null;
  changed_at: Date;
  note: string | null;
}

function projectView(row: PipelineRow): PipelineView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    site_id: row.site_id,
    talent_record_id: row.talent_record_id,
    requisition_id: row.requisition_id,
    status: row.status,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

function projectHistoryView(
  row: PipelineStatusHistoryRow,
): PipelineStatusHistoryView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    pipeline_id: row.pipeline_id,
    status_from: row.status_from,
    status_to: row.status_to,
    changed_by_id: row.changed_by_id,
    changed_at: row.changed_at.toISOString(),
    note: row.note,
  };
}

@Injectable()
export class PipelineRepository {
  private readonly logger = new Logger(PipelineRepository.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Write path — create at no_contact
  // -------------------------------------------------------------------------

  async create(args: {
    tenant_id: string;
    input: CreatePipelineRequestDto;
  }): Promise<PipelineView> {
    // Initial state hard-coded to `no_contact` per directive §2 /
    // state-machine proof initial-state invariant. Body cannot override.
    const row = await this.prisma.pipeline.create({
      data: {
        tenant_id: args.tenant_id,
        site_id: args.input.site_id ?? null,
        talent_record_id: args.input.talent_record_id,
        requisition_id: args.input.requisition_id,
        status: 'no_contact',
      },
    });
    return projectView(row as PipelineRow);
  }

  async delete(args: {
    tenant_id: string;
    id: string;
    requestId: string;
  }): Promise<void> {
    const existing = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
      select: { id: true },
    });
    if (existing === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }
    // Intra-schema FK on PipelineStatusHistory uses ON DELETE CASCADE,
    // so history rows fall away with the parent (matches the
    // RequisitionAssignment precedent at A3).
    await this.prisma.pipeline.delete({ where: { id: args.id } });
  }

  // -------------------------------------------------------------------------
  // Write path — THE state-machine transition (directive §3)
  // -------------------------------------------------------------------------

  async transition(args: {
    tenant_id: string;
    id: string;
    to_status: PipelineStatus;
    changed_by_id: string;
    note?: string;
    requestId: string;
  }): Promise<PipelineView> {
    const current = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    if (current === null) {
      throw new AramoError(
        'NOT_FOUND',
        'Pipeline not found in tenant',
        404,
        { requestId: args.requestId, details: { id: args.id } },
      );
    }

    const fromStatus = (current as PipelineRow).status;

    // Step 2 — no-op guard. Same status: return current view with no
    // history row, no activity row, no metering event.
    if (fromStatus === args.to_status) {
      this.logger.log({
        event: 'pipeline_transition_noop',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        status: fromStatus,
      });
      return projectView(current as PipelineRow);
    }

    // Step 3 — legality check (the state machine). Illegal → 422.
    if (!canTransition(fromStatus, args.to_status)) {
      this.logger.log({
        event: 'pipeline_transition_refused',
        tenant_id: args.tenant_id,
        pipeline_id: args.id,
        code: 'INVALID_PIPELINE_TRANSITION',
        from_status: fromStatus,
        to_status: args.to_status,
      });
      throw new AramoError(
        'INVALID_PIPELINE_TRANSITION',
        `Illegal pipeline status transition: ${fromStatus} -> ${args.to_status}`,
        422,
        {
          requestId: args.requestId,
          details: {
            pipeline_id: args.id,
            from_status: fromStatus,
            to_status: args.to_status,
          },
        },
      );
    }

    // Step 4 — atomic 4-write transaction.
    //
    // The activity write goes through insertActivityInTx (cross-schema
    // $executeRaw) so it shares the SAME Prisma client / transaction
    // scope as the pipeline-internal writes. Same DB, same tx — Ruling 6
    // atomicity.
    const subject_id = args.id;
    const tenant_id = args.tenant_id;
    const noteForActivity =
      args.note === undefined ? null : args.note;
    const note = args.note ?? null;
    const site_id = (current as PipelineRow).site_id ?? undefined;
    const transitionNote =
      `pipeline ${fromStatus} -> ${args.to_status}` +
      (noteForActivity === null ? '' : `: ${noteForActivity}`);

    const [updatedRow, historyRow] = await this.prisma.$transaction([
      // 4a — UPDATE Pipeline.status
      this.prisma.pipeline.update({
        where: { id: args.id },
        data: { status: args.to_status },
      }),
      // 4b — INSERT PipelineStatusHistory
      this.prisma.pipelineStatusHistory.create({
        data: {
          tenant_id,
          pipeline_id: args.id,
          status_from: fromStatus,
          status_to: args.to_status,
          changed_by_id: args.changed_by_id,
          note,
        },
      }),
      // 4c — INSERT activity."Activity" (cross-schema raw insert).
      insertActivityInTx(this.prisma, {
        tenant_id,
        ...(site_id === undefined ? {} : { site_id }),
        type: 'pipeline_status_change',
        subject_type: 'pipeline',
        subject_id,
        notes: transitionNote,
        created_by_id: args.changed_by_id,
      }),
      // 4d — INSERT metering."UsageEvent" (cross-schema raw insert).
      //      First ATS-domain metered event (Ruling 4).
      recordUsage(this.prisma, {
        tenant_id,
        event_type: 'pipeline.state_transition',
      }),
    ]);

    this.logger.log({
      event: 'pipeline_transitioned',
      tenant_id,
      pipeline_id: args.id,
      from_status: fromStatus,
      to_status: args.to_status,
      history_id: (historyRow as PipelineStatusHistoryRow).id,
    });
    return projectView(updatedRow as PipelineRow);
  }

  // -------------------------------------------------------------------------
  // Read path
  // -------------------------------------------------------------------------

  async findById(args: {
    tenant_id: string;
    id: string;
  }): Promise<PipelineView | null> {
    const row = await this.prisma.pipeline.findFirst({
      where: { tenant_id: args.tenant_id, id: args.id },
    });
    return row === null ? null : projectView(row as PipelineRow);
  }

  /**
   * List pipelines. Optionally filter by requisition_id or talent_record_id
   * (the dominant recruiter-UI queries: "all talents on this req" and
   * "all reqs for this talent"). Tenant-scoped throughout.
   */
  async list(args: {
    tenant_id: string;
    requisition_id?: string;
    talent_record_id?: string;
    limit?: number;
  }): Promise<PipelineView[]> {
    const limit = Math.min(args.limit ?? 50, 200);
    const rows = await this.prisma.pipeline.findMany({
      where: {
        tenant_id: args.tenant_id,
        ...(args.requisition_id === undefined
          ? {}
          : { requisition_id: args.requisition_id }),
        ...(args.talent_record_id === undefined
          ? {}
          : { talent_record_id: args.talent_record_id }),
      },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
    return (rows as PipelineRow[]).map(projectView);
  }

  async listHistory(args: {
    tenant_id: string;
    pipeline_id: string;
  }): Promise<PipelineStatusHistoryView[]> {
    const rows = await this.prisma.pipelineStatusHistory.findMany({
      where: {
        tenant_id: args.tenant_id,
        pipeline_id: args.pipeline_id,
      },
      orderBy: { changed_at: 'asc' },
    });
    return (rows as PipelineStatusHistoryRow[]).map(projectHistoryView);
  }
}
