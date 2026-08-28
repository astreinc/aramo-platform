// Hand-mirrored from libs/pipeline/src/lib/pipeline-state.ts and
// libs/pipeline/src/lib/dto/{pipeline.view,pipeline-status-history.view,
// transition-pipeline-request.dto}.ts. Source-annotated. R1 hand-mirrors
// instead of importing @aramo/pipeline (a forbidden domain edge).
//
// The legal-transition matrix is mirrored in ./legal-transitions.ts and
// guarded by ./legal-transitions-drift.spec.ts.

export const PIPELINE_STATUS_VALUES = [
  'no_status',
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  // L2-C (D-6) — affirmative recruiter milestone ("suitable for THIS requisition").
  'qualified',
  'submitted',
  'interviewing',
  'offered',
  'not_in_consideration',
  'client_declined',
  'placed',
  // L2-C (D-2A) — the canonical SUCCESSFUL terminal (system-only COMPLETE; SB-3).
  'completed',
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUS_VALUES)[number];

// Q3 ruling — the kanban column model.
// Active flow: 7 forward-progression columns visible by default.
// Closed: terminal states + the import-legacy `no_status` (collapsed
// area with counts).
export const ACTIVE_FLOW_COLUMNS: readonly PipelineStatus[] = [
  'no_contact',
  'contacted',
  'talent_responded',
  'qualifying',
  // L2-C — `qualified` rests between `qualifying` and `submitted` (mirrors
  // ACTIVE_FLOW_STAGES; the recruiter's affirmative milestone column).
  'qualified',
  'submitted',
  'interviewing',
  'offered',
];

export const CLOSED_STATUSES: readonly PipelineStatus[] = [
  'placed',
  // L2-C — the canonical SUCCESSFUL terminal (folds into the Closed area).
  'completed',
  'not_in_consideration',
  'client_declined',
];

// `no_status` is import-legacy only — hidden from the active flow per Q3.
// Rendered in the Closed area if a row carries it.
export const HIDDEN_FROM_ACTIVE: readonly PipelineStatus[] = ['no_status'];

// Display labels (the recruiter-facing nouns). The state-machine source
// uses snake_case identifiers; the UI shows the human form.
export const PIPELINE_STATUS_LABELS: Record<PipelineStatus, string> = {
  no_status: 'No status',
  no_contact: 'No contact',
  contacted: 'Contacted',
  talent_responded: 'Talent responded',
  qualifying: 'Qualifying',
  qualified: 'Qualified',
  submitted: 'Submitted',
  interviewing: 'Interviewing',
  offered: 'Offered',
  not_in_consideration: 'Not in consideration',
  client_declined: 'Client declined',
  placed: 'Placed',
  completed: 'Completed',
};

// REQ-PIXEL-PARITY-1-A2 (P2-A) — the derived "Next Action" per stage. This is
// UI-ONLY display sugar (what the recruiter does next given the stage) — it is
// NOT a stored field and NOT analytics data (reporting reads the status count,
// never this label). Co-located with the labels so a status-enum change updates
// both.
export const PIPELINE_NEXT_ACTION: Record<PipelineStatus, string> = {
  no_status: 'Set status',
  no_contact: 'Reach out',
  contacted: 'Await response',
  talent_responded: 'Confirm fit, rate & availability',
  qualifying: 'Confirm qualified',
  qualified: 'Prepare submittal',
  submitted: 'Await client feedback',
  interviewing: 'Manage interview',
  offered: 'Await offer decision',
  not_in_consideration: 'Closed — not proceeding',
  client_declined: 'Closed — client declined',
  // L2-C — `placed` is the LEGACY success terminal; `completed` is the canonical
  // one (reached only via the system COMPLETE command, never a recruiter action).
  placed: 'Closed — placed (legacy)',
  completed: 'Closed — completed',
};

export interface PipelineView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly talent_record_id: string;
  readonly requisition_id: string;
  readonly status: PipelineStatus;
  readonly created_at: string;
  readonly updated_at: string;
  // L2-A — optimistic-concurrency token. Echo it back as `expected_version` on
  // the next transition; a stale value is refused with PIPELINE_TRANSITION_CONFLICT.
  readonly version: number;
  // Requisition-expander enrichment (LOCKED Aramo-Requisition-Expander-Talent-
  // Rate-Columns v1.0) — composed by apps/api on the GET /v1/pipelines list only.
  // Optional: absent on non-enriched reads; null when suppressed (email/phone via
  // do_not_contact) or absent. authz (talent:read) gates existence.
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly location?: string | null;
  readonly work_auth?: string | null;
  readonly desired_rate?: string | null;
}

export interface PipelineListResponse {
  readonly items: readonly PipelineView[];
}

export interface PipelineStatusHistoryView {
  readonly id: string;
  readonly tenant_id: string;
  readonly pipeline_id: string;
  // L2-B — nullable for the birth history row (create() writes NULL -> no_contact).
  readonly status_from: PipelineStatus | null;
  readonly status_to: PipelineStatus;
  readonly changed_by_id: string | null;
  readonly changed_at: string;
  readonly note: string | null;
}

export interface PipelineHistoryResponse {
  readonly items: readonly PipelineStatusHistoryView[];
}

// L2-C — the recruiter named-action surface (POST /v1/pipelines/{id}/actions).
// Hand-mirrored from libs/pipeline/src/lib/pipeline-state.ts
// (RECRUITER_ACTION_TO_STATUS) + dto/pipeline-action-request.dto.ts. COMPLETE is
// deliberately EXCLUDED — it is the system-only command (a recruiter body carrying
// it is a 422); the FE never offers it (see recruiterNextStates in ./legal-transitions).
export type RecruiterPipelineAction =
  | 'CONTACT'
  | 'MARK_RESPONDED'
  | 'START_QUALIFICATION'
  | 'QUALIFY'
  | 'DISPOSITION';

// POST body for the named-action surface. `authority_class` + `reason` are
// REQUIRED only for DISPOSITION (a valid RECRUITER/TALENT/ENGAGEMENT pair —
// mismatch is 422 PIPELINE_DISPOSITION_REASON_INVALID). `expected_version` is the
// same optimistic-concurrency token the transition surface uses.
export interface PipelineActionRequest {
  readonly action: RecruiterPipelineAction;
  readonly expected_version: number;
  readonly reason?: string;
  readonly note?: string;
  readonly authority_class?: 'RECRUITER' | 'TALENT' | 'ENGAGEMENT';
}

// POST body for transition. `note` rides the transition transaction and
// is recorded on PipelineStatusHistory + the auto pipeline_status_change
// Activity's `notes` field (subject_type='pipeline', subject_id=pipeline.id).
export interface TransitionPipelineRequest {
  readonly to_status: PipelineStatus;
  readonly note?: string;
  // L2-A — the version the caller last read (optimistic concurrency). A stale
  // value is refused with PIPELINE_TRANSITION_CONFLICT (409, refresh and retry).
  readonly expected_version: number;
}

// Minimal talent summary for the kanban card. Hand-mirrored from
// libs/talent-record/src/lib/dto/talent-record.view.ts (just the three
// identity fields the kanban needs). R1 scopes this to pipeline/ since
// it's the only consumer; a proper talent/ module lands with R2's
// talent LIST. A follow-up: enrich PipelineView at the BE with a
// `talent_name` denormalization, or a bulk-by-ids talent endpoint,
// to replace the per-card lookup the Kanban does today.
export interface TalentRecordSummary {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
}
