// Auth-Decoupling PR-3 (ADR-0021 §2) — auth's OWN portal-login eligibility port.
// Takes a NORMALIZED email and returns an OPAQUE subject reference, or null
// (R-P23-3). This is the load-bearing inversion of ADR-0021 §2: the fingerprint
// computation MOVES INTO the Aramo adapter, so auth never computes a fingerprint,
// never imports computeEmailFingerprint, and never needs ARAMO_IDENTITY_PEPPER.
//
// `subject_ref` is OPAQUE to auth — it is passed through to
// findOrCreatePortalOnLogin unread (it happens to be a cluster id, but auth must
// not depend on that). Null means "no eligibility via the index" (a miss), NEVER
// an error (R-P23-5: the adapter preserves null-on-miss).
export const ELIGIBILITY_POLICY = 'ELIGIBILITY_POLICY';

export interface EligibilityPolicy {
  resolve(emailNormalized: string): Promise<{ subject_ref: string } | null>;
}
