// Hand-mirrored from libs/activity/src/lib/dto/{activity.view,activity-
// type,create-activity-request.dto}.ts. Source-annotated. R1 hand-mirrors
// instead of importing @aramo/activity (a forbidden domain edge).

export const ACTIVITY_TYPE_VALUES = [
  'pipeline_status_change',
  'note',
  'call',
  'email_logged',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPE_VALUES)[number];

// Q7 ruling — locked typed FE union over the BE DTO's free-string
// subject_type. The ats-web can't send a typo (the BE DTO is
// a follow-up tightening). 'contact' added for the Contacts detail
// activity timeline (note logged against a contact).
export type ActivitySubjectType =
  | 'requisition'
  | 'pipeline'
  | 'talent_record'
  | 'contact';

// Q6 finding (verified at Gate 6 from libs/pipeline/src/lib/pipeline.
// repository.ts:319-327): the auto pipeline_status_change activity emits
// with subject_type='pipeline', subject_id=<pipeline_id>. Therefore the
// req-detail timeline merges TWO subjects: req-level notes (the recruiter's
// "Log note" with subject_type='requisition') + per-pipeline transitions
// (the system-emitted subject_type='pipeline'). The merge happens
// client-side; a future BE aggregation endpoint (GET /v1/requisitions/
// :id/activities) would collapse the N+1 — filed as a follow-up.

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

export interface ActivityListResponse {
  readonly items: readonly ActivityView[];
}

export interface CreateNoteRequest {
  readonly type: 'note';
  readonly subject_type: ActivitySubjectType;
  readonly subject_id: string;
  readonly notes: string;
}
