import type { SubmittalReadiness } from '@aramo/submittal-eligibility';

// SW-4 — the backend Submittal Workspace READ projection. A UI-ready but
// domain-honest composition of EXISTING authoritative sources; it owns no business
// truth, persists nothing, and copies no rule. Every section carries only facts that
// are authoritative AND permitted for the caller; absent/optional domains are
// explicit null (never a manufactured default). Financial facts live in `commercial`,
// which is populated only when the caller holds the compensation-visibility scope.

/** id + display-name pair (name null when not resolvable / not permitted). */
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
  /** The recruiter/owner ownership context (ids + best-effort names; no account_manager column exists). */
  readonly recruiter: WorkspaceNamedRef | null;
  readonly owner: WorkspaceNamedRef | null;
  readonly talent_location: string | null;
  readonly talent_title: string | null;
  /** The policy-relevant work-authorization fact (presence/value as stored; never inferred). */
  readonly work_authorization: string | null;
}

export interface WorkspacePipelineSection {
  /** The frozen submittal→episode link (null when the submittal carries none). */
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

export interface WorkspaceDocumentsSection {
  /** RTR (Right to Represent) readiness verdict for this talent + requisition. */
  readonly rtr_satisfied: boolean;
  readonly rtr_deny: string | null;
  /** The résumé edition selected for this requisition (working selection), if any. */
  readonly resume_selected: boolean;
}

export interface WorkspaceEngagementSection {
  readonly governed: boolean;
  readonly policy_present: boolean;
  readonly satisfied: boolean;
  readonly unavailable: boolean;
}

/** Commercial facts — present ONLY when the caller holds compensation visibility. */
export interface WorkspaceCommercialSection {
  /** Live requisition commercial truth (the sole editable authority). */
  readonly live_bill_rate_amount: string | null;
  readonly live_bill_rate_currency: string | null;
  readonly live_bill_rate_period: string | null;
  /** Frozen client-facing commercial snapshot taken at the send (historical truth). */
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

/**
 * SW-6 — server-owned client-response action availability. Each flag is the FINAL
 * answer (the transition is legal from the current ClientSelection state AND the
 * caller holds the scope the governed command enforces). The FE renders each CTA iff
 * its flag is true and NEVER re-derives routing or authorization. Move-to-interview /
 * mark-selected go via POST /:id/transition; decline / withdraw via POST /:id/decision
 * (withdraw requires a closed reason_code); schedule via POST /:id/interviews.
 */
export interface WorkspaceClientSelectionActions {
  readonly can_move_to_interview: boolean;
  readonly can_mark_selected: boolean;
  readonly can_decline: boolean;
  readonly can_withdraw: boolean;
  readonly can_schedule_interview: boolean;
}

export interface WorkspaceClientSelectionSection {
  readonly present: boolean;
  /** The ClientSelectionProcess id — required to target a governed mutation. */
  readonly process_id: string | null;
  /** Optimistic-concurrency version for CAS on /transition and /decision. */
  readonly version: number | null;
  /**
   * The authoritative ClientSelectionProcess.created_at — the SOLE basis for the
   * presentation-only "in client review / waiting with client · N days" projection
   * (the same authority My Desk uses). Never persisted as a counter.
   */
  readonly opened_at: string | null;
  readonly state: string | null;
  readonly latest_interview: {
    /** InterviewSession id — enables the deep-link to the existing Interview detail. */
    readonly id: string;
    readonly round: number;
    readonly state: string;
    readonly scheduled_at: string | null;
  } | null;
  /** Response history composed from ClientSelectionEvent (reason_code + note). Newest first. */
  readonly feedback: readonly WorkspaceClientFeedbackEntry[];
  readonly available_actions: WorkspaceClientSelectionActions;
}

/**
 * Action availability — ONLY actions with existing backend/domain-owned eligibility.
 * No generic framework: each flag is a projection of an authority that already exists
 * (readiness band; the client-selection transition state machine).
 */
export interface WorkspaceActionsSection {
  /**
   * The server-owned FINAL submit-to-client CTA authority (SW-5/D-6): readiness is
   * READY *and* the caller holds the submit authority the command enforces
   * (`submittal:approve` + recruiter consumer). The FE renders the primary CTA iff
   * this is true — it never recombines readiness with authority itself. The slot
   * race remains the one mutation-time exception.
   */
  readonly can_submit_to_client: boolean;
  /**
   * Diagnostic: the caller holds submit authority, independent of readiness. Lets the
   * FE distinguish "ready but not authorized" (view-only note) from "not ready"
   * without reconstructing the authorization decision.
   */
  readonly submit_authority: boolean;
  /** The submittal is in a state that may be revoked (submittal state machine). */
  readonly can_revoke: boolean;
}

export interface SubmittalWorkspaceView {
  readonly identity: WorkspaceIdentitySection;
  readonly context: WorkspaceContextSection;
  readonly pipeline: WorkspacePipelineSection;
  readonly submittal: WorkspaceSubmittalSection;
  readonly readiness: SubmittalReadiness;
  readonly documents: WorkspaceDocumentsSection;
  readonly engagement: WorkspaceEngagementSection;
  /** Null when the caller lacks compensation visibility (field-level authorization). */
  readonly commercial: WorkspaceCommercialSection | null;
  readonly delivery: WorkspaceDeliverySection;
  readonly client_selection: WorkspaceClientSelectionSection;
  readonly actions: WorkspaceActionsSection;
}
