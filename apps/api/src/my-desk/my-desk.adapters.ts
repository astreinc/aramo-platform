import { Injectable } from '@nestjs/common';
import {
  ClientSelectionProcessRepository,
  InterviewSessionRepository,
} from '@aramo/client-selection';
import { CompanyRepository } from '@aramo/company';
import { OfferRepository, PlacementRepository } from '@aramo/placement';
import { ACTIVE_FLOW_STAGES, PipelineRepository } from '@aramo/pipeline';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';
import { TaskRepository } from '@aramo/task';

import type {
  DeskActorContext,
  DeskAwaitingRow,
  DeskBlockedPlacementRow,
  DeskDayWindow,
  DeskInterviewRow,
  DeskOfferRow,
  DeskRequisitionCounts,
  DeskRequisitionRow,
  DeskTaskOwnerType,
  DeskTaskRow,
  DeskTaskType,
  MyDeskReadPort,
} from './my-desk.ports.js';

// The concrete MyDeskReadPort — the ONLY layer that touches the real domain
// repositories. It maps each aggregate's view down to the narrow desk row shape
// and does no derivation (that lives in MyDeskService/my-desk.derivation.ts).
// Every list is bounded; the visibility set is passed through untouched
// (server-resolved, never client-supplied — directive §24).
const LIST_LIMIT = 200;

@Injectable()
export class MyDeskReadAdapter implements MyDeskReadPort {
  constructor(
    private readonly tasks: TaskRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly pipelines: PipelineRepository,
    private readonly interviews: InterviewSessionRepository,
    private readonly clientSelection: ClientSelectionProcessRepository,
    private readonly placements: PlacementRepository,
    private readonly offers: OfferRepository,
    private readonly talent: TalentRecordRepository,
    private readonly companies: CompanyRepository,
  ) {}

  async listMyTasks(ctx: DeskActorContext): Promise<readonly DeskTaskRow[]> {
    const rows = await this.tasks.listForAssignee({
      tenant_id: ctx.tenant_id,
      assignee_id: ctx.user_id,
      vis: {
        visibility: ctx.visibility,
        visible_requisition_ids: ctx.visible_requisition_ids,
        visible_contact_ids: ctx.visible_contact_ids,
      },
      limit: LIST_LIMIT,
    });
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      due_date: t.due_date,
      type: t.type as DeskTaskType | null,
      owner_type: t.owner_type as DeskTaskOwnerType,
      owner_id: t.owner_id,
    }));
  }

  async listMyRequisitions(
    ctx: DeskActorContext,
  ): Promise<readonly DeskRequisitionRow[]> {
    const rows = await this.requisitions.listForActor({
      tenant_id: ctx.tenant_id,
      visibility: ctx.visibility,
    });
    return rows.map((r) => ({
      id: r.id,
      requisition_number: r.requisition_number,
      title: r.title,
      company_id: r.company_id,
      status: r.status,
      created_at: r.created_at,
      is_hot: r.is_hot,
    }));
  }

  async countsForRequisitions(
    ctx: DeskActorContext,
    requisition_ids: readonly string[],
  ): Promise<ReadonlyMap<string, DeskRequisitionCounts>> {
    if (requisition_ids.length === 0) return new Map();
    const ids = [...requisition_ids];
    // Five indexed groupBy reads across the owning domains — NO row loading,
    // NO LIST_LIMIT. Each returns [{requisition_id, count}] for the SAME id set.
    const [pipeline, qualified, withClient, offer, started] = await Promise.all([
      this.pipelines.countByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
        statuses: ACTIVE_FLOW_STAGES,
      }),
      this.pipelines.countByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
        statuses: ['qualified'],
      }),
      this.clientSelection.countWithClientByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
      this.offers.countLiveByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
      this.placements.countStartedByRequisition({
        tenant_id: ctx.tenant_id,
        requisition_ids: ids,
      }),
    ]);
    type MutableCounts = {
      pipeline: number;
      qualified: number;
      with_client: number;
      offer: number;
      started: number;
    };
    const acc = new Map<string, MutableCounts>();
    const ensure = (reqId: string): MutableCounts => {
      let m = acc.get(reqId);
      if (m === undefined) {
        m = { pipeline: 0, qualified: 0, with_client: 0, offer: 0, started: 0 };
        acc.set(reqId, m);
      }
      return m;
    };
    for (const r of pipeline) ensure(r.requisition_id).pipeline = r.count;
    for (const r of qualified) ensure(r.requisition_id).qualified = r.count;
    for (const r of withClient) ensure(r.requisition_id).with_client = r.count;
    for (const r of offer) ensure(r.requisition_id).offer = r.count;
    for (const r of started) ensure(r.requisition_id).started = r.count;
    return acc;
  }

  async activeRequisitionsByTalent(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    if (talent_ids.length === 0) return new Map();
    const rows = await this.pipelines.listActiveRequisitionsByTalent({
      tenant_id: ctx.tenant_id,
      talent_record_ids: [...talent_ids],
      visible_requisition_ids: ctx.visible_requisition_ids,
    });
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.talent_record_id) ?? [];
      list.push(r.requisition_id);
      out.set(r.talent_record_id, list);
    }
    return out;
  }

  async listInterviewsInWindow(
    ctx: DeskActorContext,
    window: DeskDayWindow,
  ): Promise<readonly DeskInterviewRow[]> {
    const rows = await this.interviews.listScheduledInWindowForRequisitions({
      tenant_id: ctx.tenant_id,
      from: new Date(window.start_iso),
      to: new Date(window.end_iso),
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((iv) => ({
      id: iv.id,
      scheduled_at: iv.scheduled_at,
      talent_record_id: iv.talent_record_id,
      requisition_id: iv.requisition_id,
      interview_type: iv.interview_type,
      round: iv.round,
      state: iv.state,
    }));
  }

  async listAwaitingClient(
    ctx: DeskActorContext,
  ): Promise<readonly DeskAwaitingRow[]> {
    const rows = await this.clientSelection.listInReviewForRequisitions({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((p) => ({
      id: p.id,
      talent_id: p.talent_id,
      requisition_id: p.requisition_id,
      created_at: p.created_at,
    }));
  }

  async listBlockedPlacements(
    ctx: DeskActorContext,
  ): Promise<readonly DeskBlockedPlacementRow[]> {
    const rows = await this.placements.listForActor({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows
      .filter((p) => p.state === 'BLOCKED')
      .map((p) => ({
        id: p.id,
        talent_record_id: p.talent_record_id,
        requisition_id: p.requisition_id,
        proposed_start_date:
          p.proposed_start_date === null
            ? null
            : p.proposed_start_date.toISOString().slice(0, 10),
      }));
  }

  async listExpiringOffers(
    ctx: DeskActorContext,
  ): Promise<readonly DeskOfferRow[]> {
    const rows = await this.offers.list({
      tenant_id: ctx.tenant_id,
      visible_requisition_ids: ctx.visible_requisition_ids,
      limit: LIST_LIMIT,
    });
    return rows.map((o) => ({
      id: o.id,
      talent_record_id: o.talent_record_id,
      requisition_id: o.requisition_id,
      state: o.state,
      offer_expires_at: o.offer_expires_at,
    }));
  }

  async resolveTalentNames(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.talent.findNamesByIds({
      tenant_id: ctx.tenant_id,
      ids: talent_ids,
    });
  }

  async resolveCompanyNames(
    ctx: DeskActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.companies.findNamesByIds({
      tenant_id: ctx.tenant_id,
      ids: company_ids,
    });
  }
}
