// Settings Rebuild Directive 2 — hand-mirrored audit read shapes.
//
// ats-web stays a leaf consumer of the HTTP surface: these re-declare the
// AuditEventView / event-type set that libs/identity owns. The event-type set
// is the closed enumeration the filter dropdown renders (kept in lock-step with
// libs/identity's EVENT_TYPES; a structural drift smoke spec is unnecessary
// here — the backend rejects an unknown event_type with 400, so a stale entry
// fails loudly rather than silently).

export type AuditCategory =
  | 'setting'
  | 'access'
  | 'user'
  | 'org'
  | 'session'
  | 'system';

export interface AuditActorView {
  readonly id: string | null;
  readonly type: 'system' | 'service_account' | 'user';
  readonly display: string;
}

export interface AuditEventView {
  readonly id: string;
  readonly event_type: string;
  readonly category: AuditCategory;
  readonly actor: AuditActorView;
  readonly subject_id: string;
  readonly detail: string;
  readonly created_at: string;
}

export interface AuditQueryResult {
  readonly items: readonly AuditEventView[];
  readonly next_cursor: string | null;
}

export interface AuditFilters {
  readonly event_type?: string;
  readonly actor_id?: string;
  readonly subject_id?: string;
  readonly from?: string;
  readonly to?: string;
}
