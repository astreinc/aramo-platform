// Auth-Decoupling PR-4 (ADR-0021 §2) — auth's OWN audit-event sink. A separate
// port from PrincipalDirectory (audit is an event sink, not a directory; folding
// it in makes both incoherent — R-P4-2), but landed in the SAME PR because both
// live on the live login path and touching it twice is worse than once.
//
// `context_id` (optional) is the tenant scope; when present the adapter routes to
// a tenant-scoped write, when absent to a global write. auth emits
// `session.issued` / `session.refreshed` / `session.reuse_detected` /
// `session.revoked` through this sink; `external_identity.linked` is emitted
// INSIDE the PrincipalDirectory adapter (internal to resolution).
//
// R-P4-2 — `record` MUST NEVER THROW. Audit is best-effort; an audit failure that
// broke a login/refresh/logout would be a severe regression.
export interface AuditRecord {
  event_type: string;
  actor_id: string;
  context_id?: string;
  subject_id: string;
  payload?: Record<string, unknown>;
}

export const AUDIT_SINK = 'AUDIT_SINK';

export interface AuditSink {
  record(event: AuditRecord): Promise<void>;
}
