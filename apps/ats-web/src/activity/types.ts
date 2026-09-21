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

// RN-1 (LOCKED) — hand-mirrored from libs/activity/src/lib/dto/{note-category,
// note-visibility,note-body-format}.ts (R1 forbidden-edge: mirror, don't import
// @aramo/activity). Guarded by a drift test. NoteCategory is the ratified
// 7-value set (Q4); NoteVisibility ships TEAM + PRIVATE only in RN-1 (Q1) —
// RESTRICTED is deferred to RN-2. body_format is plain_text only (D-5).
export const NOTE_CATEGORY_VALUES = [
  'GENERAL',
  'CLIENT_INTERACTION',
  'HIRING_TEAM',
  'COMMERCIAL',
  'INTERVIEW_FEEDBACK',
  'DECISION',
  'RISK_BLOCKER',
] as const;
export type NoteCategory = (typeof NOTE_CATEGORY_VALUES)[number];

export const NOTE_VISIBILITY_VALUES = ['TEAM', 'PRIVATE'] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITY_VALUES)[number];

export type NoteBodyFormat = 'plain_text';

// Human labels for the RN-1 category selector.
export const NOTE_CATEGORY_LABELS: Readonly<Record<NoteCategory, string>> = {
  GENERAL: 'General',
  CLIENT_INTERACTION: 'Client interaction',
  HIRING_TEAM: 'Hiring team',
  COMMERCIAL: 'Commercial',
  INTERVIEW_FEEDBACK: 'Interview feedback',
  DECISION: 'Decision',
  RISK_BLOCKER: 'Risk / blocker',
};

export const NOTE_VISIBILITY_LABELS: Readonly<Record<NoteVisibility, string>> = {
  TEAM: 'Requisition team',
  PRIVATE: 'Private to me',
};

// D-6 — server-enforced note-body bound. Mirrored for the FE counter/guard.
export const NOTE_BODY_MAX_LENGTH = 20000;

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
  // Redaction (Charter §4 Amendment). redacted_at non-null = the note body was
  // cleared; the row, author and timestamp survive. redaction_reason free text
  // is present for the recruiter audit but is NEVER rendered (§8).
  readonly redacted_at: string | null;
  readonly redacted_by: string | null;
  readonly redaction_reason_code: string | null;
  readonly redaction_reason: string | null;
  // RN-1 (LOCKED) note attributes — non-null only when type=note.
  readonly category: NoteCategory | null;
  readonly visibility: NoteVisibility | null;
  readonly body_format: NoteBodyFormat | null;
  readonly is_pinned: boolean;
  readonly pinned_at: string | null;
  readonly pinned_by_id: string | null;
}

export interface ActivityListResponse {
  readonly items: readonly ActivityView[];
}

export interface CreateNoteRequest {
  readonly type: 'note';
  readonly subject_type: ActivitySubjectType;
  readonly subject_id: string;
  readonly notes: string;
  // RN-1 — category/visibility default server-side (GENERAL/TEAM) when omitted;
  // pinned defaults false. body_format is NOT sent (server-set plain_text).
  readonly category?: NoteCategory;
  readonly visibility?: NoteVisibility;
  readonly pinned?: boolean;
}
