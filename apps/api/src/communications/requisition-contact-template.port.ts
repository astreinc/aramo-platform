// COMM-C4 (RCE-1) — the requisition-contact email template contract. The
// template DEFINITION is system-owned and code-owned this increment (no DB
// table, no picker, no tenant editing, no LLM). The recruiter edits the
// GENERATED draft, never this definition. The contract is shaped so a future
// tenant-managed store can implement the same port without changing the
// draft/send endpoints or the evidence model (INV-9).

export const REQUISITION_CONTACT_TEMPLATE_RESOLVER = 'REQUISITION_CONTACT_TEMPLATE_RESOLVER';

// Authoritative context the backend reloads (never supplied by the browser).
// Every human-readable field is nullable: an unavailable field degrades
// gracefully (block omitted + factual warning), never emits a raw placeholder.
export interface RequisitionContactContext {
  readonly talent_first_name: string | null;
  readonly requisition_title: string;
  readonly requisition_reference: string;
  readonly location: string | null; // e.g. "McLean, VA"
  readonly location_short: string | null; // e.g. "McLean, VA" for the subject
  readonly work_arrangement: string | null; // onsite | hybrid | remote (raw)
  readonly engagement_type: string | null; // job_type (raw)
  // DEC-1 — authoritative requisition text the OPTIONAL role-summary block is a
  // DETERMINISTIC, source-preserving excerpt of. NEVER LLM-generated. Null when
  // no suitable authoritative source field exists (the block is then omitted).
  readonly role_summary_source: string | null;
  readonly recruiter_display_name: string | null;
  readonly tenant_recruiting_company_name: string | null;
}

export interface HydratedDraft {
  readonly subject: string;
  readonly body: string;
  readonly template_id: string;
  readonly template_version: string;
  // Factual, bounded: names optional context that was omitted. NOT a policy
  // engine — a closed vocabulary of `<field>_unavailable` markers.
  readonly warnings: readonly string[];
}

export interface RequisitionContactTemplateResolver {
  /** Hydrate the single governed requisition-contact template (auto-applied). */
  resolveDefault(context: RequisitionContactContext): HydratedDraft;
}
