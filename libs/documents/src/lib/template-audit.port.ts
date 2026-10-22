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

// DOC-TEMPLATE-LIB-1 T-6 (§9; ADR-0034 D10) — an Aramo (PLATFORM) default withdrawal
// was published or cancelled by a platform operator. A PLATFORM template belongs to no
// tenant, so the event is GLOBAL (no tenant_id). Written BEFORE the state change and
// MUST throw on failure, so a withdrawal never happens without its audit record.
export interface TemplatePlatformWithdrawalAudit {
  readonly action: 'published' | 'cancelled';
  readonly actor_id: string;
  readonly template_id: string;
  readonly document_type_id: string;
  // ISO-8601. For 'published': the new notice/effective dates. For 'cancelled': the
  // dates being cleared.
  readonly withdraw_notice_at: string | null;
  readonly withdraw_effective_at: string | null;
  readonly notice_days?: number;
  readonly reason?: string | null;
  readonly requestId: string;
}

// ORG-UX-1 (Directive v1.0 LOCKED §5.4) — Org template governance. Tenant-scoped. Written
// through the same non-swallowing seam AFTER the state change succeeds (the change is
// already committed; a failed write surfaces as an error to the caller, never silently).
export type TemplateGovernanceAction = 'adopted' | 'created' | 'version_activated' | 'selection_set' | 'selection_cleared';
export interface TemplateGovernanceAudit {
  readonly action: TemplateGovernanceAction;
  readonly tenant_id: string;
  readonly actor_id: string;
  // The template (adopted / created / selection_set), the version (version_activated) or
  // the document type (selection_cleared).
  readonly subject_id: string;
  readonly payload: Readonly<Record<string, string | number | null>>;
  readonly requestId: string;
}

export interface TemplateAuditPort {
  recordDraftDiscarded(event: TemplateDraftDiscardedAudit): Promise<void>;
  recordPlatformWithdrawal(event: TemplatePlatformWithdrawalAudit): Promise<void>;
  recordGovernance(event: TemplateGovernanceAudit): Promise<void>;
}
