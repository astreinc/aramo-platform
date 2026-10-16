// DOC-TEMPLATE-ADMIN-RTR-1 Amendment A1 §1 — Discard draft MUST write a template audit
// event (actor, version, time). Documents owns no template audit store and must not
// invent a parallel audit subsystem (parent §43), so the write is delegated through this
// port to the tenant audit ledger at the composition root (apps/api binds it to the
// identity audit repository — the same app-layer audit seam TenantSettingsController
// uses). Keeps libs/documents free of an @aramo/identity edge.
//
// recordDraftDiscarded MUST throw if the event cannot be written: the controller writes
// the audit event BEFORE deleting, so a discard never happens without its audit record.

export const TEMPLATE_AUDIT = 'TEMPLATE_AUDIT';

export interface TemplateDraftDiscardedAudit {
  readonly tenant_id: string;
  readonly actor_id: string;
  readonly template_id: string;
  readonly version_id: string;
  readonly version_number: number;
  readonly requestId: string;
}

export interface TemplateAuditPort {
  recordDraftDiscarded(event: TemplateDraftDiscardedAudit): Promise<void>;
}
