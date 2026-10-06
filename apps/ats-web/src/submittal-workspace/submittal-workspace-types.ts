// SW-5 — the Submittal Workspace view, hand-mirrored from the backend projection
// apps/api/src/submittal-workspace/submittal-workspace.view.ts (SW-4) + the SW-3
// readiness shape. Per the FE-foundation discipline we hand-mirror the DTO rather
// than import an @aramo/* domain type. This file carries NO business rule: every
// field is a fact the server already decided; the FE only renders it. Drift is
// guarded by submittal-workspace.contract.spec.ts.

export interface WorkspaceNamedRef {
  readonly id: string;
  readonly name: string | null;
}

export interface WorkspaceIdentitySection {
  readonly submittal_id: string;
  readonly talent: WorkspaceNamedRef;
  readonly requisition: { readonly id: string; readonly title: string | null };
  readonly company: WorkspaceNamedRef | null;
}

export interface WorkspaceContextSection {
  readonly recruiter: WorkspaceNamedRef | null;
  readonly owner: WorkspaceNamedRef | null;
  readonly talent_location: string | null;
  readonly talent_title: string | null;
  readonly work_authorization: string | null;
}

export interface WorkspacePipelineSection {
  readonly linked_episode_id: string | null;
  readonly current_stage: string | null;
  readonly is_live: boolean;
}

export interface WorkspaceSubmittalSection {
  readonly state: string;
  readonly created_at: string | null;
  readonly created_by: string | null;
  readonly confirmed_at: string | null;
  readonly revoked_at: string | null;
  readonly resume_edition_id: string | null;
}

// SW-3 requirement shape (the unified readiness authority). Rendered generically:
// the FE never branches on `key` for business truth — only for icon/known-route
// presentation mapping.
export interface SubmittalRequirement {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly satisfied: boolean;
  readonly severity: 'blocking' | 'overridable' | 'info';
  readonly source: string;
  readonly reason: string | null;
  readonly remediation: string | null;
  readonly deny_code: string | null;
}

export interface SubmittalReadiness {
  readonly status: 'READY' | 'NEEDS_ACTION' | 'BLOCKED';
  readonly requirements: readonly SubmittalRequirement[];
}

export interface WorkspaceDocumentsSection {
  readonly rtr_satisfied: boolean;
  readonly rtr_deny: string | null;
  readonly resume_selected: boolean;
}

export interface WorkspaceEngagementSection {
  readonly governed: boolean;
  readonly policy_present: boolean;
  readonly satisfied: boolean;
  readonly unavailable: boolean;
}

// Present ONLY when the caller holds compensation visibility (field-level authz);
// null otherwise. Note: SW-4 carries live + frozen BILL rate only (no pay/margin).
export interface WorkspaceCommercialSection {
  readonly live_bill_rate_amount: string | null;
  readonly live_bill_rate_currency: string | null;
  readonly live_bill_rate_period: string | null;
  readonly submitted_bill_rate: string | null;
  readonly submitted_rate_currency: string | null;
  readonly submitted_rate_period: string | null;
}

export interface WorkspaceDeliverySection {
  readonly delivery_channel: string | null;
  readonly external_reference: string | null;
  readonly external_submitted_at: string | null;
  readonly submitted_at: string | null;
  readonly submitted_by_actor_id: string | null;
}

export interface WorkspaceClientFeedbackEntry {
  readonly at: string;
  readonly to_state: string | null;
  readonly reason_code: string | null;
  readonly note: string | null;
}

// SW-6 — server-owned client-response action availability (legal transition AND the
// caller holds the governed scope). The FE renders each CTA iff its flag is true and
// never re-derives routing or authorization.
export interface WorkspaceClientSelectionActions {
  readonly can_move_to_interview: boolean;
  readonly can_mark_selected: boolean;
  readonly can_decline: boolean;
  readonly can_withdraw: boolean;
  readonly can_schedule_interview: boolean;
}

export interface WorkspaceClientSelectionSection {
  readonly present: boolean;
  readonly process_id: string | null;
  readonly version: number | null;
  /** ClientSelectionProcess.created_at — retained for display only; the waiting age
   *  is the server-computed `waiting_days` (canonical client-waiting semantic). */
  readonly opened_at: string | null;
  /** Canonical "waiting on client" age (whole civil days, app timezone); null unless
   *  the selection is in CLIENT_REVIEW. Rendered as-is — the FE never recomputes it. */
  readonly waiting_days: number | null;
  readonly state: string | null;
  readonly latest_interview: {
    readonly id: string;
    readonly round: number;
    readonly state: string;
    readonly scheduled_at: string | null;
  } | null;
  readonly feedback: readonly WorkspaceClientFeedbackEntry[];
  readonly available_actions: WorkspaceClientSelectionActions;
}

export interface WorkspaceActionsSection {
  // Server-owned FINAL CTA authority (SW-5/D-6): readiness READY AND the caller
  // holds submit authority. The FE renders the primary CTA iff this is true.
  readonly can_submit_to_client: boolean;
  // Diagnostic: holds submit authority independent of readiness (distinguishes
  // "ready but view-only" from "not ready" without recomputing authorization).
  readonly submit_authority: boolean;
  readonly can_revoke: boolean;
}

// SW-6 — the closed set of client-withdrawal reason codes (mirrors the domain's
// WITHDRAW_REASON_EFFECT; the server validates the code authoritatively). WITHDRAWN
// via POST /:id/decision REQUIRES one of these.
export const WITHDRAW_REASON_CODES = [
  'TALENT_WITHDREW',
  'TALENT_UNAVAILABLE',
  'RECRUITER_DISPOSITIONED',
  'ADMIN_CORRECTION',
  'RESUBMITTAL',
  'CLIENT_PROCESS_CANCELLED',
] as const;
export type WithdrawReasonCode = (typeof WITHDRAW_REASON_CODES)[number];

export interface SubmittalWorkspaceView {
  readonly identity: WorkspaceIdentitySection;
  readonly context: WorkspaceContextSection;
  readonly pipeline: WorkspacePipelineSection;
  readonly submittal: WorkspaceSubmittalSection;
  readonly readiness: SubmittalReadiness;
  readonly documents: WorkspaceDocumentsSection;
  readonly engagement: WorkspaceEngagementSection;
  readonly commercial: WorkspaceCommercialSection | null;
  readonly delivery: WorkspaceDeliverySection;
  readonly client_selection: WorkspaceClientSelectionSection;
  readonly actions: WorkspaceActionsSection;
}

// The delivery channels offered in V1 (manual only). Values map EXACTLY to the SW-2
// submittal.SubmittalDeliveryChannel enum (ALL_DELIVERY_CHANNELS in
// apps/api/src/submit-talent/submit-talent.service.ts). `aramo_connector` is
// intentionally NOT offered (no outbound connector exists; the server refuses it).
// The server validates the chosen channel authoritatively at submit.
export const V1_MANUAL_DELIVERY_CHANNELS = [
  'manual_vms',
  'manual_client_portal',
  'manual_email',
  'manual_other',
] as const;
export type V1ManualDeliveryChannel = (typeof V1_MANUAL_DELIVERY_CHANNELS)[number];

export interface RecordSubmittalRequest {
  readonly delivery_channel: string;
  readonly external_reference?: string;
  readonly external_submitted_at?: string;
}
