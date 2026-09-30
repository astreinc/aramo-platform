import type { VisibilityContextShape } from '@aramo/common';
import type { InterviewSessionState } from '@aramo/client-selection';

// Narrow READ PORTS the InterviewsService composes over. Each port is the minimal row
// shape the calendar projection needs — NOT a full domain view. The concrete adapter
// (interviews.adapters.ts) wraps the real repositories; the service depends only on the
// ports, so its composition/enrichment is unit-testable with in-memory fakes (no
// Testcontainers). This keeps the interview calendar a READ projection with zero domain
// authority (Calendar/Interview §2: InterviewSession is the authority; this only reads).

// The authenticated, visibility-resolved actor context handed to every port. tenant_id /
// user_id come from the token; the visible-requisition set is resolved server-side (null
// = see-all short-circuit). No client-supplied identifiers ever (Calendar/Interview §29).
export interface InterviewsActorContext {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly site_id?: string;
  readonly visibility: VisibilityContextShape;
  readonly visible_requisition_ids: ReadonlySet<string> | null;
}

// The bounded calendar query — a required [from, to) window plus optional ANDed filters.
export interface InterviewCalendarFilters {
  readonly from: Date;
  readonly to: Date;
  readonly requisition_id?: string;
  readonly talent_record_id?: string;
  readonly interviewer_user_id?: string;
  readonly state?: InterviewSessionState;
}

// The raw InterviewSession row the calendar read returns (pre-enrichment).
export interface CalendarSessionRow {
  readonly id: string;
  readonly scheduled_at: string;
  readonly scheduled_end_at: string | null;
  readonly timezone: string | null;
  readonly state: InterviewSessionState;
  readonly round: number;
  readonly interview_type: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly interviewer_user_ids: readonly string[];
  readonly version: number;
}

// The requisition display label (resolved once per calendar read, keyed by id).
export interface RequisitionLabel {
  readonly requisition_number: number | null;
  readonly title: string | null;
  readonly company_id: string | null;
}

export interface InterviewsReadPort {
  listCalendarSessions(
    ctx: InterviewsActorContext,
    filters: InterviewCalendarFilters,
  ): Promise<readonly CalendarSessionRow[]>;
  resolveTalentNames(
    ctx: InterviewsActorContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  resolveRequisitionLabels(
    ctx: InterviewsActorContext,
  ): Promise<ReadonlyMap<string, RequisitionLabel>>;
  resolveCompanyNames(
    ctx: InterviewsActorContext,
    ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export const INTERVIEWS_READ_PORT = Symbol('INTERVIEWS_READ_PORT');
