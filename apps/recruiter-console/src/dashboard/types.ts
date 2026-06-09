// Hand-mirrored from libs/reporting/src/lib/dto/report.view.ts. R-home
// hand-mirrors instead of importing @aramo/reporting (a forbidden domain
// edge per the FROZEN fe-foundation discipline). Three of the four nested
// enums (RequisitionStatus / PipelineStatus / ActivityType) are REUSED
// from the existing recruiter-console mirrors (not re-mirrored). The
// fourth (CalendarEventType) is added here as a flat value-list — no
// drift-spec per rule-of-three (flat-value mirrors carry no logic).

import type { ActivityType } from '../activity/types';
import type { PipelineStatus } from '../pipeline/types';
import type { RequisitionStatus } from '../requisitions/types';

// CalendarEventType — 6 closed-list values mirrored from
// libs/calendar/src/lib/dto/calendar-event-type.ts. Flat value-list; no
// drift smoke (R2 precedent — flat DTOs don't need it; promote to a
// shared mirror when a 2nd consumer appears).
export const CALENDAR_EVENT_TYPE_VALUES = [
  'call',
  'email',
  'meeting',
  'interview',
  'personal',
  'other',
] as const;
export type CalendarEventType = (typeof CALENDAR_EVENT_TYPE_VALUES)[number];

export const CALENDAR_EVENT_TYPE_LABELS: Record<CalendarEventType, string> = {
  call: 'Call',
  email: 'Email',
  meeting: 'Meeting',
  interview: 'Interview',
  personal: 'Personal',
  other: 'Other',
};

// Activity type labels — re-used from the activity module's already-
// canonical vocabulary. Kept here as a local label map so the dashboard
// renders without coupling its column-render to the activity module.
export const ACTIVITY_TYPE_LABELS: Record<ActivityType, string> = {
  pipeline_status_change: 'Pipeline status change',
  note: 'Note',
  call: 'Call',
  email_logged: 'Email logged',
};

// Requisition status labels — the requisitions module mirrors the values
// but no label map. The rollup display needs human-readable copy; this is
// the home-local label table for the 6 closed values.
export const REQUISITION_STATUS_LABELS: Record<RequisitionStatus, string> = {
  active: 'Active',
  on_hold: 'On hold',
  full: 'Full',
  closed: 'Closed',
  canceled: 'Canceled',
  lead: 'Lead',
};

// TenantCountsReportView — 6 number fields.
export interface TenantCountsReportView {
  readonly companies: number;
  readonly contacts: number;
  readonly talent_records: number;
  readonly saved_lists: number;
  readonly calendar_events: number;
  readonly activities: number;
}

export interface RequisitionRollupItem {
  readonly status: RequisitionStatus;
  readonly count: number;
}

export interface RequisitionStatusRollupView {
  readonly total: number;
  readonly by_status: readonly RequisitionRollupItem[];
}

export interface PipelineRollupItem {
  readonly status: PipelineStatus;
  readonly count: number;
}

export interface PipelineStageRollupView {
  readonly total: number;
  readonly by_status: readonly PipelineRollupItem[];
}

// PlacementCountReportView — placed_pipelines is the user-facing count.
// includes_core_submittal_placements is the T5 seam annotation
// (informational only, fixed `false`); per Ruling A this field is NOT
// rendered in the UI — kept on the FE type for shape parity with the BE
// DTO so the API client can read the response without an unknown-field
// pruning step.
export interface PlacementCountReportView {
  readonly placed_pipelines: number;
  readonly includes_core_submittal_placements: false;
}

// CalendarEventView — flat hand-mirror (12 fields).
export interface CalendarEventView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly owner_id: string;
  readonly type: CalendarEventType;
  readonly title: string;
  readonly description: string | null;
  readonly starts_at: string;
  readonly ends_at: string | null;
  readonly all_day: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

// ActivityView — flat hand-mirror. subject_type is loose-typed at the BE
// (string | null); the recruiter-console already hand-mirrors a narrower
// FE union in activity/types.ts, but the dashboard accepts the loose
// shape since it only renders the type/notes/timestamp triple.
export interface ActivityView {
  readonly id: string;
  readonly tenant_id: string;
  readonly site_id: string | null;
  readonly type: ActivityType;
  readonly subject_type: string | null;
  readonly subject_id: string | null;
  readonly notes: string | null;
  readonly created_by_id: string | null;
  readonly created_at: string;
}

export interface DashboardView {
  readonly tenant_counts: TenantCountsReportView;
  readonly requisition_rollup: RequisitionStatusRollupView;
  readonly pipeline_rollup: PipelineStageRollupView;
  readonly placement: PlacementCountReportView;
  readonly upcoming_events: readonly CalendarEventView[];
  readonly recent_activity: readonly ActivityView[];
}
