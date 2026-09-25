import { apiClient } from '@aramo/fe-foundation';

// Requisition Talent Board (TB-2) — the read-only Board client. Consumes the apps/api
// composer (GET /v1/requisitions/:id/talent-board). NO Board business truth lives here: the
// backend is authoritative for every column, owner attribution, Closed derivation, readiness
// band and résumé linkage. These types HAND-MIRROR the backend projection DTO
// (apps/api/.../dto/requisition-talent-board.view.ts) — STATE ENUMS ONLY (no compensation).

export type BoardColumnKey =
  | 'pipeline'
  | 'contacted'
  | 'qualified'
  | 'submitted'
  | 'interview'
  | 'selected'
  | 'offer'
  | 'accepted'
  | 'prestart'
  | 'ready'
  | 'started';

export type BoardOwner = 'pipeline' | 'submittal' | 'client_selection' | 'offer' | 'placement';
export type QualifiedBand = 'ready_to_submit' | 'needs_action';

export interface BoardReadiness {
  readonly requisition_state: 'open' | 'paused' | 'closed';
  readonly requisition_reason: string | null;
  readonly blockers: readonly string[];
  readonly band: QualifiedBand | null;
}

export interface BoardResume {
  readonly resume_edition_id: string | null;
  readonly source: 'working_selection' | 'submitted_frozen' | 'none';
  readonly locked: boolean;
}

// TB-3 — a bounded governed next action (hand-mirror of the backend BoardNextAction).
export interface BoardNextAction {
  readonly key: string;
  readonly label: string;
  readonly owner: BoardOwner;
  readonly command_route: string;
  readonly required_scope: string;
}

export interface BoardCardView {
  readonly talent_record_id: string;
  readonly pipeline_id: string;
  readonly column: BoardColumnKey;
  readonly owner: BoardOwner;
  readonly source_object_id: string;
  readonly owner_state: string;
  readonly resume: BoardResume;
  readonly rtr_state: string | null;
  readonly readiness: BoardReadiness | null;
  readonly days_in_stage: number | null;
  readonly stage_entered_at: string | null;
  readonly assigned_recruiter_user_id: string | null;
  readonly next_actions: readonly BoardNextAction[];
}

export interface BoardColumnView {
  readonly key: BoardColumnKey;
  readonly owner: BoardOwner;
  readonly count: number;
  readonly cards: readonly BoardCardView[];
}

export interface BoardClosedSummary {
  readonly total: number;
  readonly by_reason: ReadonlyArray<{ reason: string; count: number }>;
}

export interface RequisitionTalentBoardView {
  readonly requisition_id: string;
  readonly columns: readonly BoardColumnView[];
  readonly closed: BoardClosedSummary;
  readonly total_active: number;
}

export async function getRequisitionTalentBoard(requisitionId: string): Promise<RequisitionTalentBoardView> {
  return apiClient.get<RequisitionTalentBoardView>(`/v1/requisitions/${requisitionId}/talent-board`);
}

// ---- presentational maps (Board-owned display vocabulary; not owner ontologies) -----------
export const BOARD_COLUMN_LABELS: Record<BoardColumnKey, string> = {
  pipeline: 'Pipeline',
  contacted: 'Contacted',
  qualified: 'Qualified',
  submitted: 'Submitted',
  interview: 'Interviewing',
  selected: 'Client Selected',
  offer: 'Offer',
  accepted: 'Offer Accepted',
  prestart: 'Pre-Start',
  ready: 'Ready to Start',
  started: 'Started',
};

// Human-legible labels for the canonical Closed reasons the backend emits (owner enums).
export const BOARD_CLOSED_REASON_LABELS: Record<string, string> = {
  not_in_consideration: 'Not in consideration',
  client_declined: 'Client declined',
  client_withdrawn: 'Withdrawn',
  offer_declined: 'Offer declined',
  offer_expired: 'Offer expired',
  offer_rescinded: 'Offer rescinded',
  placement_no_show: 'No-show',
  placement_fell_through: 'Fell through',
};

export function closedReasonLabel(reason: string): string {
  return BOARD_CLOSED_REASON_LABELS[reason] ?? reason;
}

// The Qualified-band blocker labels. TB-4 grounds these on the real eligibility port: the
// submittal-window + RTR deny codes are the port's; résumé-selected is the Board's orthogonal
// pre-check. (requisition_paused/closed retained for the requisition-grain window display.)
export const BOARD_BLOCKER_LABELS: Record<string, string> = {
  resume_not_selected: 'Résumé not selected',
  rtr_not_executed: 'Right to represent not executed',
  submittal_window_passed: 'Submittal window passed',
  submittal_limit_reached: 'Submittal limit reached',
  submittals_closed: 'Submittals closed',
  requisition_paused: 'Requisition paused',
  requisition_closed: 'Requisition closed',
};

export function blockerLabel(blocker: string): string {
  return BOARD_BLOCKER_LABELS[blocker] ?? blocker;
}
