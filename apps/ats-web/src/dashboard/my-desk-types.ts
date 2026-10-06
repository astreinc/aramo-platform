// Hand-mirror of apps/api/src/my-desk/dto/my-desk.view.ts (MyDeskView).
//
// ats-web HAND-MIRRORS backend read DTOs — it never imports @aramo/* domain
// libs (the FROZEN fe-foundation discipline; same pattern as dashboard/types.ts).
// The desk is a READ PROJECTION: the FE derives every card and tab count from
// these arrays (there is no `summary` field to drift from). Urgency and
// server_date are computed server-side against the app timezone; the FE renders
// them, it does not re-derive them.

export type DeskUrgency = 'overdue' | 'today' | 'upcoming';

export type DeskItemKind =
  | 'follow_up'
  | 'client'
  | 'rtr'
  | 'submittal'
  | 'engagement'
  | 'task';

export type DeskActionKind =
  | 'log_call'
  | 'log_voice_call'
  | 'reply_client'
  | 'send_rtr'
  | 'send_reminder'
  | 'submit_to_client'
  | 'start_qualification'
  | 'update_talent'
  | 'open_task'
  | 'review_advisory'
  | 'update_email'
  // CRM-7 (§11) — follow-up communication-authority CTAs (resolved FE-side).
  | 'call'
  | 'email'
  // Offer & Start §11 — deep-link an exception into the single journey; rendered as a plain
  // link to the action's href (/offer-start/:pipelineId). Narrow, not a generic router.
  | 'continue_offer_start';

export interface DeskActionView {
  readonly kind: DeskActionKind;
  readonly label: string;
  readonly href: string | null;
}

export interface DeskPriorityItemView {
  readonly id: string;
  readonly kind: DeskItemKind;
  readonly talent_id: string | null;
  readonly talent_name: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly label: string;
  readonly reason: string;
  readonly due_at: string | null;
  readonly urgency: DeskUrgency;
  readonly primary_action: DeskActionView | null;
  // CRM-7 (§11) — backing Task id when the row IS a Task (Done/Snooze target);
  // null for domain-derived work items.
  readonly task_id: string | null;
}

export type DeskInterviewConfirmation =
  | 'confirmed'
  | 'talent_not_confirmed'
  | 'unknown';

export interface DeskInterviewView {
  readonly id: string;
  readonly scheduled_at: string;
  readonly talent_id: string | null;
  readonly talent_name: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly interview_type: string;
  readonly round: number | null;
  readonly confirmation: DeskInterviewConfirmation;
}

export type DeskExceptionKind =
  | 'pre_start_blocked'
  | 'offer_expiring'
  | 'identity_advisory';

export type DeskExceptionSeverity = 'high' | 'medium';

export interface DeskExceptionView {
  readonly id: string;
  readonly kind: DeskExceptionKind;
  readonly severity: DeskExceptionSeverity;
  readonly title: string;
  readonly body: string;
  readonly talent_id: string | null;
  readonly requisition_id: string | null;
  readonly owned_by_me: boolean;
  readonly owner_label: string | null;
  readonly primary_action: DeskActionView | null;
}

export interface DeskAwaitingClientView {
  readonly id: string;
  readonly talent_id: string | null;
  readonly talent_name: string | null;
  readonly requisition_id: string | null;
  readonly requisition_label: string | null;
  readonly reason: string;
  readonly waiting_days: number;
  readonly since: string;
}

export interface DeskRequisitionRowView {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly client_name: string | null;
  readonly days_open: number;
  readonly status: string;
  readonly pipeline_count: number;
  readonly qualified_count: number;
  readonly with_client_count: number;
  readonly offer_count: number;
  readonly started_count: number;
  readonly signal: string;
}

export interface MyDeskView {
  readonly generated_at: string;
  readonly server_date: string;
  readonly priority_items: readonly DeskPriorityItemView[];
  readonly interviews_today: readonly DeskInterviewView[];
  readonly awaiting_client: readonly DeskAwaitingClientView[];
  readonly exceptions: readonly DeskExceptionView[];
  readonly requisitions: readonly DeskRequisitionRowView[];
}
