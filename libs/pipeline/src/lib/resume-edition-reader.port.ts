// TALENT-INTEL-1 TI-1D-D — the dependency-inversion PORT by which the (scope:ats)
// Pipeline reads a Talent's résumé editions WITHOUT importing @aramo/talent-evidence
// (scope:cip) directly (module-boundary wall). The concrete adapter lives in the
// apps/api composition layer (which may reach talent-evidence) and is bound to
// RESUME_EDITION_READER @Global — mirroring RESUME_ATTACHMENT_RESOLVER /
// COMPANY_CLIENT_CHECK_PORT. A STRING token (not the bare interface) avoids the
// non-strict app.get bare-class provider-collision trap.

/**
 * A Talent's résumé edition as the Pipeline needs it: identity + lifecycle (for
 * eligibility) + the tenant/talent presentation default marker + a little document
 * metadata for display. NO raw evidence payload; NO résumé text.
 */
export interface ResumeEditionSummary {
  edition_id: string;
  /** 'active' | 'retracted' | 'archived' — gates NEW selection eligibility. */
  lifecycle_status: string;
  /** The Talent-GLOBAL presentation default (a suggestion only; NOT authoritative
   *  for a requisition). */
  is_default: boolean;
  purpose: string;
  label: string | null;
  filename: string;
  mime_type: string;
  created_at: string;
}

/**
 * Reads a Talent's résumé editions, tenant-scoped. Talent-scoped by construction
 * (the caller passes the pipeline's tenant + talent), so any edition in the result
 * belongs to that Talent — the Pipeline uses this both to present the collection
 * (GET) and to validate a new selection's eligibility (PUT).
 */
export interface ResumeEditionReaderPort {
  listResumeEditions(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<ResumeEditionSummary[]>;
}

/** Injection token (STRING, not the bare interface — collision-safe). */
export const RESUME_EDITION_READER = 'RESUME_EDITION_READER';
