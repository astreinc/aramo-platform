import { Injectable } from '@nestjs/common';
import { InterviewSessionRepository } from '@aramo/client-selection';
import { CompanyRepository } from '@aramo/company';
import { RequisitionRepository } from '@aramo/requisition';
import { TalentRecordRepository } from '@aramo/talent-record';

import type {
  CalendarSessionRow,
  InterviewCalendarFilters,
  InterviewsActorContext,
  InterviewsReadPort,
  RequisitionLabel,
} from './interviews.ports.js';

// The concrete InterviewsReadPort — the ONLY layer that touches real repositories. It
// sources InterviewSession via the interview authority's `listForCalendar` (NEVER
// CalendarEvent, per Calendar/Interview §2) and resolves display labels the same way My
// Desk does (`findNamesByIds` / `listForActor`) — no new lib reads. Every read is
// visibility-scoped; the server-resolved visibility set is passed through untouched.
@Injectable()
export class InterviewsReadAdapter implements InterviewsReadPort {
  constructor(
    private readonly interviews: InterviewSessionRepository,
    private readonly requisitions: RequisitionRepository,
    private readonly talent: TalentRecordRepository,
    private readonly companies: CompanyRepository,
  ) {}

  async listCalendarSessions(
    ctx: InterviewsActorContext,
    filters: InterviewCalendarFilters,
  ): Promise<readonly CalendarSessionRow[]> {
    const rows = await this.interviews.listForCalendar({
      tenant_id: ctx.tenant_id,
      from: filters.from,
      to: filters.to,
      visible_requisition_ids: ctx.visible_requisition_ids,
      ...(filters.requisition_id === undefined
        ? {}
        : { requisition_id: filters.requisition_id }),
      ...(filters.talent_record_id === undefined
        ? {}
        : { talent_record_id: filters.talent_record_id }),
      ...(filters.interviewer_user_id === undefined
        ? {}
        : { interviewer_user_id: filters.interviewer_user_id }),
      ...(filters.state === undefined ? {} : { state: filters.state }),
    });
    return rows.map((iv) => ({
      id: iv.id,
      scheduled_at: iv.scheduled_at,
      scheduled_end_at: iv.scheduled_end_at,
      timezone: iv.timezone,
      state: iv.state,
      round: iv.round,
      interview_type: iv.interview_type,
      talent_record_id: iv.talent_record_id,
      requisition_id: iv.requisition_id,
      interviewer_user_ids: iv.interviewer_user_ids,
      version: iv.version,
    }));
  }

  async resolveTalentNames(
    ctx: InterviewsActorContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.talent.findNamesByIds({ tenant_id: ctx.tenant_id, ids });
  }

  async resolveRequisitionLabels(
    ctx: InterviewsActorContext,
  ): Promise<ReadonlyMap<string, RequisitionLabel>> {
    const rows = await this.requisitions.listForActor({
      tenant_id: ctx.tenant_id,
      visibility: ctx.visibility,
    });
    const out = new Map<string, RequisitionLabel>();
    for (const r of rows) {
      out.set(r.id, {
        requisition_number: r.requisition_number ?? null,
        title: r.title ?? null,
        company_id: r.company_id ?? null,
      });
    }
    return out;
  }

  async resolveCompanyNames(
    ctx: InterviewsActorContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    return this.companies.findNamesByIds({ tenant_id: ctx.tenant_id, ids });
  }
}
