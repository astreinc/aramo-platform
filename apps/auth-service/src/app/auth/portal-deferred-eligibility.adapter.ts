import { Injectable } from '@nestjs/common';
import type { EligibilityPolicy } from '@aramo/auth-core';

// ATI-SEP-1 T10 WP4 — Addendum A4 (Talent Portal identity deferral; gap
// GAP-PORTAL-ID-1). The legacy eligibility source (an email fingerprint looked
// up in the retired cross-tenant identity index → an opaque cluster ref) is
// gone with that schema. Until the Portal identity increment delivers a
// Portal-owned eligibility source (A4 target boundary: Portal↔ATS / Portal↔TI
// through versioned service contracts only; never a TI-subscription dependency
// for login), this adapter answers "no eligibility" for EVERY address.
//
// Behaviour (PortalLoginService, unchanged): a null resolve is the existing
// uniform path — request-link sends mail only to an address that already has a
// PortalUser (else the same silent neutral response), and consume() lazy-mints
// / finds the PortalUser with cluster_id null. The repository's fill-once rule
// never clears an existing cluster_id, so no portal_identity data is mutated
// destructively (A4 §3). ORACLE-RESISTANCE holds trivially: the answer does not
// depend on the input. Recruiter / admin login never used this port (A4 §4).
@Injectable()
export class PortalDeferredEligibilityAdapter implements EligibilityPolicy {
  async resolve(_emailNormalized: string): Promise<{ subject_ref: string } | null> {
    return null;
  }
}
