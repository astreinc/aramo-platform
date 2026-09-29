// Narrow READ PORTS the MyDeskService composes over. Each port is the minimal
// row shape the desk projection needs from an owning aggregate — NOT the full
// domain view. Concrete adapters (my-desk.adapters.ts) wrap the real
// repositories to satisfy these; the service depends only on the ports, so its
// composition/derivation logic is unit-testable with in-memory fakes (no
// Testcontainers). This keeps My Desk a READ projection with zero domain
// authority (directive §23/§40).

import type { VisibilityContextShape } from '@aramo/common';

// The authenticated, visibility-resolved actor context handed to every port.
// tenant_id / user_id come from the token; the visibility set + contact ids are
// resolved server-side (null = see-all short-circuit). No client-supplied
// identifiers ever (directive §24). The service reads only tenant_id +
// visible_requisition_ids; the adapters use the full visibility inputs to drive
// the underlying repositories.
export interface DeskActorContext {
  readonly tenant_id: string;
  readonly user_id: string;
  readonly site_id?: string;
  readonly visibility: VisibilityContextShape;
  readonly visible_requisition_ids: ReadonlySet<string> | null;
  readonly visible_contact_ids: ReadonlySet<string> | null;
}

// task.type values the desk maps to a queue kind (subset that the desk renders).
export type DeskTaskType =
  | 'follow_up'
  | 'interview'
  | 'screen'
  | 'consent'
  | 'call'
  | 'email'
  | 'admin';

export type DeskTaskOwnerType =
  | 'talent_record'
  | 'requisition'
  | 'company'
  | 'contact';

export interface DeskTaskRow {
  readonly id: string;
  readonly title: string;
  readonly due_date: string | null;
  readonly type: DeskTaskType | null;
  readonly owner_type: DeskTaskOwnerType;
  readonly owner_id: string;
}

// A pipeline row, used to tally per-requisition counts (≤ qualified — the
// pipeline-owned stages) AND to resolve a talent-owned task's requisition when
// the talent sits on a single active pipeline. status is a loose string (the
// desk does not re-declare the pipeline enum).
export interface DeskPipelineRow {
  readonly requisition_id: string;
  readonly talent_record_id: string;
  readonly status: string;
}

export interface DeskRequisitionRow {
  readonly id: string;
  // Per-tenant internal number; the human code renders as REQ-{number}.
  readonly requisition_number: number;
  readonly title: string;
  readonly company_id: string;
  readonly status: string;
  readonly created_at: string;
  readonly is_hot: boolean;
}

export interface DeskInterviewRow {
  readonly id: string;
  readonly scheduled_at: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly interview_type: string;
  readonly round: number;
  // SCHEDULED / RESCHEDULED / COMPLETED / CANCELED / NO_SHOW — loose string.
  readonly state: string;
}

// A client-selection process sitting in CLIENT_REVIEW (Awaiting-client).
export interface DeskAwaitingRow {
  readonly id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly created_at: string;
}

// A placement in the BLOCKED state (pre-start exception).
export interface DeskBlockedPlacementRow {
  readonly id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly proposed_start_date: string | null;
}

// An offer with an expiry instant (offer-expiring exception).
export interface DeskOfferRow {
  readonly id: string;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly state: string;
  readonly offer_expires_at: string | null;
}

// A UTC half-open day window [start, end) the interview read filters on. The
// service computes it from the app timezone so "today" is a civil day, not a
// UTC day (directive §38).
export interface DeskDayWindow {
  readonly start_iso: string;
  readonly end_iso: string;
}

export interface MyDeskReadPort {
  listMyTasks(ctx: DeskActorContext): Promise<readonly DeskTaskRow[]>;
  listMyRequisitions(ctx: DeskActorContext): Promise<readonly DeskRequisitionRow[]>;
  listPipelinesForRequisitions(
    ctx: DeskActorContext,
    requisition_ids: readonly string[],
  ): Promise<readonly DeskPipelineRow[]>;
  listInterviewsInWindow(
    ctx: DeskActorContext,
    window: DeskDayWindow,
  ): Promise<readonly DeskInterviewRow[]>;
  listAwaitingClient(
    ctx: DeskActorContext,
  ): Promise<readonly DeskAwaitingRow[]>;
  listBlockedPlacements(
    ctx: DeskActorContext,
  ): Promise<readonly DeskBlockedPlacementRow[]>;
  listExpiringOffers(ctx: DeskActorContext): Promise<readonly DeskOfferRow[]>;
  // Batch id → "First Last" resolution (bounded by the ids the desk already
  // holds). Missing ids simply do not appear in the map.
  resolveTalentNames(
    ctx: DeskActorContext,
    talent_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
  resolveCompanyNames(
    ctx: DeskActorContext,
    company_ids: readonly string[],
  ): Promise<ReadonlyMap<string, string>>;
}

export const MY_DESK_READ_PORT = 'MY_DESK_READ_PORT';
