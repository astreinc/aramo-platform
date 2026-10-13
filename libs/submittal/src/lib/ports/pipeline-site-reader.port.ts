// INC-1b (TIP-E2E) — PipelineSiteReader port.
//
// Submittal lifecycle mutations (confirm / mark-ready / confirm-ats / revoke)
// must enforce server-resolved SITE authorization + requisition actor-visibility
// BEFORE any state transition or event write. The authoritative site +
// requisition + talent context lives on the Pipeline domain, not on the submittal
// row. libs/submittal must NOT reach into pipeline's schema directly (no
// cross-schema SQL here, I1/boundary discipline); instead it depends on this
// small, explicit, tenant-scoped read contract. The adapter is supplied by the
// composition root (apps/api) over the authoritative Pipeline domain.
//
// Fail-closed: a null result (pipeline absent / not in tenant / id mismatch) means
// the caller MUST refuse the mutation — never a free pass.

export interface PipelineAuthorizationContext {
  /** The pipeline's site (null = tenant-wide pipeline, admitted on any site). */
  readonly site_id: string | null;
  /** The requisition the pipeline episode belongs to (authoritative; used for the
   *  actor requisition-visibility check and the submittal↔pipeline↔requisition
   *  consistency assertion). */
  readonly requisition_id: string;
  /** The talent the pipeline episode belongs to (used for chain-consistency). */
  readonly talent_record_id: string;
}

export interface PipelineSiteReader {
  /**
   * Resolve the authoritative, TENANT-SCOPED pipeline authorization context for a
   * pipeline id. Returns null when the pipeline does not exist within the tenant —
   * callers MUST fail closed on null.
   */
  resolveForAuthorization(args: {
    tenant_id: string;
    pipeline_id: string;
  }): Promise<PipelineAuthorizationContext | null>;
}

export const PIPELINE_SITE_READER = Symbol('PIPELINE_SITE_READER');
