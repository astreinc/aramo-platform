// Slice B (Calendar/Interview §9) — the cross-domain interviewer tenant-user validation
// seam. The client-selection lib is L3-walled (UUID-ref only, no identity import), so the
// schedule path asserts interviewer validity through THIS port rather than reaching into
// identity directly. The concrete adapter is bound by the composition root (apps/api) over
// IdentityService; the lib depends only on this interface (no new nx edge from the lib).
// The adapter throws a typed AramoError when any id is not a current tenant user
// (fail-closed). An empty id list is a no-op.
export interface InterviewerValidatorPort {
  assertValidTenantInterviewers(args: {
    tenant_id: string;
    interviewer_user_ids: readonly string[];
    requestId: string;
  }): Promise<void>;
}

// String injection token (not a class token) — avoids the bare-class-token non-strict
// lookup collision, and keeps the lib free of any concrete-adapter reference.
export const INTERVIEWER_VALIDATOR = 'INTERVIEWER_VALIDATOR';
