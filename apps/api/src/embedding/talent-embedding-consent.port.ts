// Enterprise Search GS-2 P4 — the ai_processing consent seam for the Talent embedding path.
// The Talent embedding pipeline (P5 worker) MUST hold this authorization before it generates or
// persists any semantic vector for a Talent, and MUST invalidate an existing vector when the
// decision turns to a definite `denied` (revocation). Consent is the INDEPENDENT `ai_processing`
// operation checked against the sole Consent authority (libs/consent) — never inferred from any
// other operation, résumé existence, or record state. Fail-closed: allowed ONLY on an explicit
// `allowed` decision.
//
// STRING token (not a bare class) per the non-strict-lookup collision rule — a module-local
// provider of a shared class type can shift `app.get(Type,{strict:false})` winners.
export const TALENT_EMBEDDING_CONSENT_PORT = 'TALENT_EMBEDDING_CONSENT_PORT';

export interface TalentEmbeddingConsentDecision {
  readonly allowed: boolean;
  // Present only when !allowed. `denied` = a stable revocation → the worker invalidates any existing
  // vector. `error` = the authority reported an error/unknown state → skip this attempt (do NOT
  // invalidate on an uncertain state). A thrown error (transient infra) is NOT mapped here — it
  // propagates so the worker's retry path handles it without falsely invalidating.
  readonly reason?: 'denied' | 'error';
  // Durable reference to the consent decision that authorized this embedding (provenance).
  readonly consent_decision_ref?: string;
}

export interface TalentEmbeddingConsentPort {
  evaluate(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<TalentEmbeddingConsentDecision>;
}
