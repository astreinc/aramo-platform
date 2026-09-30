import { Inject, Injectable } from '@nestjs/common';

import type {
  InterviewCalendarRowView,
  InterviewCalendarView,
} from './dto/interview-calendar.view.js';
import {
  INTERVIEWS_READ_PORT,
  type InterviewCalendarFilters,
  type InterviewsActorContext,
  type InterviewsReadPort,
} from './interviews.ports.js';

// GET /v1/interviews composition — the interview CALENDAR read. A READ PROJECTION with
// zero domain authority (Calendar/Interview §2): it composes the InterviewSession
// calendar read with Talent / Requisition / company display enrichment. It depends only
// on the port, so this composition is unit-testable with in-memory fakes. On an empty
// window it short-circuits (no enrichment reads issued).
@Injectable()
export class InterviewsService {
  constructor(
    @Inject(INTERVIEWS_READ_PORT) private readonly port: InterviewsReadPort,
  ) {}

  async listCalendar(
    ctx: InterviewsActorContext,
    filters: InterviewCalendarFilters,
  ): Promise<InterviewCalendarView> {
    const window = {
      from: filters.from.toISOString(),
      to: filters.to.toISOString(),
    };
    const sessions = await this.port.listCalendarSessions(ctx, filters);
    if (sessions.length === 0) return { interviews: [], window };

    const talentIds = [...new Set(sessions.map((s) => s.talent_record_id))];
    const [talentNames, reqLabels] = await Promise.all([
      this.port.resolveTalentNames(ctx, talentIds),
      this.port.resolveRequisitionLabels(ctx),
    ]);
    const companyIds = [
      ...new Set(
        [...reqLabels.values()]
          .map((l) => l.company_id)
          .filter((x): x is string => x !== null),
      ),
    ];
    const companyNames = await this.port.resolveCompanyNames(ctx, companyIds);

    const interviews: InterviewCalendarRowView[] = sessions.map((s) => {
      const label = reqLabels.get(s.requisition_id) ?? null;
      const company_id = label?.company_id ?? null;
      return {
        id: s.id,
        scheduled_at: s.scheduled_at,
        scheduled_end_at: s.scheduled_end_at,
        timezone: s.timezone,
        state: s.state,
        round: s.round,
        interview_type: s.interview_type,
        talent_record_id: s.talent_record_id,
        talent_name: talentNames.get(s.talent_record_id) ?? null,
        requisition_id: s.requisition_id,
        requisition_number: label?.requisition_number ?? null,
        requisition_title: label?.title ?? null,
        company_id,
        company_name:
          company_id === null ? null : companyNames.get(company_id) ?? null,
        interviewer_user_ids: s.interviewer_user_ids,
        version: s.version,
      };
    });
    return { interviews, window };
  }
}
