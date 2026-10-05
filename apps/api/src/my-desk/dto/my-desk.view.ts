// MyDeskView — the recruiter command-center read PROJECTION (GET /v1/my-desk).
//
// This is a READ COMPOSITION, not a domain authority: every field is projected
// from an owning aggregate (task / pipeline / engagement / submittal /
// client-selection / interview / placement / offer / talent-trust). It creates
// NO state and owns NO invariant. Business derivation (urgency classification,
// the FACTS-only `reason` prose, deterministic ordering) is computed
// server-side so the FE renders without re-deriving — see my-desk.derivation.ts.
//
// Vocabulary: the queue kind uses the canonical `submittal` / `talent` terms;
// the Tier-2 replacements are enforced by scripts/verify-vocabulary.sh. There is
// NO numeric priority-ordinal field anywhere (R10 / directive §40): ordering is
// an explainable urgency+due comparator, never a hidden number.

import type { RecruitingStatus } from '@aramo/requisition';

// urgency is computed against the app timezone (directive §38) — the FE never
// compares a UTC string to a browser-local date; it groups by this value.
export type DeskUrgency = 'overdue' | 'today' | 'upcoming';

// The recruiter-facing queue kinds (directive §9). Deliberately compressed from
// backend implementation concepts into recruiter outcomes (directive §12).
export type DeskItemKind =
  | 'follow_up'
  | 'client'
  | 'rtr'
  | 'submittal'
  | 'engagement'
  | 'task';

// Contextual-action kinds. Each maps to an EXISTING production workflow the FE
// reuses (directive §15) — My Desk orchestrates, it does not re-implement.
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
  // CRM-7 (§11) — follow-up communication-authority CTAs. 'call' = execute a
  // voice contact (no requisition, voice permitted); 'email' = requisition-
  // contextual email (requisition present, email permitted). The FE resolves
  // each affordance from `kind`; a Task never grants the communication action.
  | 'call'
  | 'email'
  // Offer & Start §11 — deep-link an Offer & Start exception into the single
  // person × requisition journey. Narrow: the FE renders it as a plain link to
  // the action's `href` (/offer-start/:pipelineId); emitted ONLY where the
  // backend resolved an authoritative pipeline episode. NOT a generic router.
  | 'continue_offer_start';

export interface DeskActionView {
  readonly kind: DeskActionKind;
  readonly label: string;
  // A client-side route the FE can navigate to reuse the existing flow, when
  // the action is a navigation rather than an in-place mutation. null when the
  // FE resolves the affordance from `kind` alone.
  readonly href: string | null;
}

export interface DeskPriorityItemView {
  readonly id: string;
  readonly kind: DeskItemKind;
  readonly talent_id: string | null;
  readonly talent_name: string | null;
  readonly requisition_id: string | null;
  // The human requisition code (external_req_id), e.g. "REQ-1001"; null when the
  // requisition has no external code.
  readonly requisition_label: string | null;
  // The row's primary subject line (usually the talent name).
  readonly label: string;
  // WHY this needs attention — FACTS only, no verdict (directive §12/§42).
  readonly reason: string;
  readonly due_at: string | null;
  readonly urgency: DeskUrgency;
  readonly primary_action: DeskActionView | null;
  // CRM-7 (§11) — the backing Task id when this row IS a Task (so the FE can
  // invoke the Task PATCH for Done/Snooze). null for domain-DERIVED work items
  // (submittal-ready / RTR / voice) that have no Task to mutate.
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
  // e.g. "client_interview" / "recruiter_screen" — the raw interview_type; the
  // FE label map translates to concise UX copy.
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
  // Whether the current recruiter owns the remediation (directive §20). When
  // false, the FE shows `owner_label` instead of an action.
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
  // The underlying waiting reason, preserved (directive §21) — normalized under
  // "Awaiting client" for display but kept truthful here.
  readonly reason: string;
  // Whole calendar days waiting, computed against the app timezone.
  readonly waiting_days: number;
  readonly since: string;
}

export interface DeskRequisitionRowView {
  readonly id: string;
  // Human requisition code, e.g. "REQ-1001".
  readonly code: string;
  readonly title: string;
  readonly client_name: string | null;
  readonly days_open: number;
  readonly status: RecruitingStatus;
  // Pipeline-owned counts (≤ qualified). with_client/offer/started are
  // downstream-owned (the A7 seam) and composed from the owning aggregates.
  readonly pipeline_count: number;
  readonly qualified_count: number;
  readonly with_client_count: number;
  readonly offer_count: number;
  readonly started_count: number;
  // Concise operational signal (directive §22) — FACTS only.
  readonly signal: string;
}

export interface MyDeskView {
  // Server clock (ISO) at composition time — the FE renders the header date
  // from server_date, never from the browser clock (directive §38).
  readonly generated_at: string;
  // The app-timezone calendar date as YYYY-MM-DD (drives the header date line).
  readonly server_date: string;
  // The single collection the FE derives every card AND tab count from — so a
  // badge can never drift from the list (directive §14).
  readonly priority_items: readonly DeskPriorityItemView[];
  readonly interviews_today: readonly DeskInterviewView[];
  readonly awaiting_client: readonly DeskAwaitingClientView[];
  readonly exceptions: readonly DeskExceptionView[];
  readonly requisitions: readonly DeskRequisitionRowView[];
}
