// COMM-RECRUITER-W1 (W1-A1) — the General Talent Contact email-template contract.
// Talent-only (no requisition). The template DEFINITION is system-owned and
// code-owned this slice (tenant OVERRIDE via the existing EmailTemplate store, no
// new subsystem, no versioning, no LLM). The recruiter edits the GENERATED draft,
// never this definition. Shaped like the requisition-contact port (INV-9) so the
// same tenant-managed store implements both without changing draft/send.

import type { HydratedDraft } from './requisition-contact-template.port.js';

export const GENERAL_TALENT_CONTACT_TEMPLATE_RESOLVER = 'GENERAL_TALENT_CONTACT_TEMPLATE_RESOLVER';

// Authoritative context the backend reloads (never browser-supplied). All fields
// nullable: an unavailable field degrades gracefully (block omitted + factual
// warning), never a raw placeholder. CLOSED binding catalog (§4B-cat): exactly
// talent.first_name, recruiter.display_name, company.name — NO requisition context.
export interface GeneralTalentContactContext {
  readonly talent_first_name: string | null;
  readonly recruiter_display_name: string | null;
  readonly tenant_recruiting_company_name: string | null;
}

export interface GeneralTalentContactTemplateResolver {
  /** Hydrate the single governed General Talent Contact default (auto-applied). */
  resolveDefault(context: GeneralTalentContactContext): HydratedDraft;
}
