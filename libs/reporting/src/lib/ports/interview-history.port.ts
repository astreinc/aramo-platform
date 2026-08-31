// Lane 2 / L2-I (D4b) — the REPORTING-OWNED interview-history port.
//
// The seam that lets ReportingService source the hiring-funnel INTERVIEW stage from the
// authoritative Client-Selection / InterviewSession owner WITHOUT libs/reporting importing
// @aramo/client-selection (the A7 seam walls it). libs/reporting OWNS this interface (the
// semantic — "the FIRST interview per (talent, requisition) grain"); the IMPLEMENTATION is a
// @aramo/client-selection-backed adapter wired at the apps/api composition root. Mirrors the
// L2-E SUBMITTED_HISTORY_PORT exactly. Typed values only cross it — no bare owner literals.

// One interview (talent, requisition) grain: the FIRST scheduled interview instant.
export interface InterviewHistoryGrain {
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly first_interview_at: Date;
}

export interface InterviewHistoryQuery {
  readonly tenant_id: string;
  readonly requisition_ids?: readonly string[];
}

export interface InterviewHistoryPort {
  findFirstInterviewByGrain(query: InterviewHistoryQuery): Promise<readonly InterviewHistoryGrain[]>;
}

// DI token — the apps/api composition root binds it to the @aramo/client-selection-backed adapter.
export const INTERVIEW_HISTORY_PORT = Symbol('INTERVIEW_HISTORY_PORT');
