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
  'submitted',
  'interviewing',
  'offered',
  'not_in_consideration',
  'client_declined',
  'placed',
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
  'submitted',
  'interviewing',
  'offered',
];

export const CLOSED_STATUSES: readonly PipelineStatus[] = [
  'placed',
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
  submitted: 'Submitted',
  interviewing: 'Interviewing',
  offered: 'Offered',
  not_in_consideration: 'Not in consideration',
  client_declined: 'Client declined',
  placed: 'Placed',
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
}

export interface PipelineListResponse {
  readonly items: readonly PipelineView[];
}

export interface PipelineStatusHistoryView {
  readonly id: string;
  readonly tenant_id: string;
  readonly pipeline_id: string;
  readonly status_from: PipelineStatus;
  readonly status_to: PipelineStatus;
  readonly changed_by_id: string | null;
  readonly changed_at: string;
  readonly note: string | null;
}

export interface PipelineHistoryResponse {
  readonly items: readonly PipelineStatusHistoryView[];
}

// POST body for transition. `note` rides the transition transaction and
// is recorded on PipelineStatusHistory + the auto pipeline_status_change
// Activity's `notes` field (subject_type='pipeline', subject_id=pipeline.id).
export interface TransitionPipelineRequest {
  readonly to_status: PipelineStatus;
  readonly note?: string;
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
