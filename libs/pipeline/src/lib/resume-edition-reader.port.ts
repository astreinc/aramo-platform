// TALENT-INTEL-1 TI-1D-D — the dependency-inversion PORT by which the (scope:ats)
// Pipeline reads a Talent's resume editions WITHOUT importing @aramo/talent-evidence
// (scope:cip) directly (module-boundary wall). The concrete adapter lives in the
// apps/api composition layer (which may reach talent-evidence) and is bound to
// RESUME_EDITION_READER @Global — mirroring RESUME_ATTACHMENT_RESOLVER /
// COMPANY_CLIENT_CHECK_PORT. A STRING token (not the bare interface) avoids the
// non-strict app.get bare-class provider-collision trap.

/**
 * A Talent's resume edition as the Pipeline needs it: identity + lifecycle (for
 * eligibility) + the tenant/talent presentation default marker + a little document
 * metadata for display. NO raw evidence payload; NO resume text.
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
  /** Resume Revision Lifecycle §3/§5 — the requisition this edition was tailored
   *  for (null for a general edition). Drives §5 ordering (tailored-for-current-
   *  requisition first) and the "Tailored for REQ" label. UUID-only; never
   *  inferred from filename/contents. */
  requisition_id: string | null;
  filename: string;
  mime_type: string;
  created_at: string;
}

/**
 * Reads a Talent's resume editions, tenant-scoped. Talent-scoped by construction
 * (the caller passes the pipeline's tenant + talent), so any edition in the result
 * belongs to that Talent — the Pipeline uses this both to present the collection
 * (GET) and to validate a new selection's eligibility (PUT).
 */
export interface ResumeEditionReaderPort {
  listResumeEditions(input: {
    tenant_id: string;
    talent_id: string;
  }): Promise<ResumeEditionSummary[]>;

  /**
   * BATCHED-by-ids read — the editions whose id ∈ edition_ids, tenant-scoped.
   * ONE query (id IN (...)); an empty edition_ids short-circuits to [] (NEVER a
   * per-id loop). Any returned row's tenant is the caller's tenant by
   * construction. Consumed by the Requisition Talent Board to project a whole
   * page's résumé editions (label / date / tailored-for-requisition marker) in a
   * single read — never per card.
   */
  listResumeEditionsByIds(input: {
    tenant_id: string;
    edition_ids: readonly string[];
  }): Promise<ResumeEditionSummary[]>;
}

/** Injection token (STRING, not the bare interface — collision-safe). */
export const RESUME_EDITION_READER = 'RESUME_EDITION_READER';
