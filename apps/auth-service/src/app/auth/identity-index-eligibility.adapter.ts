import { Injectable } from '@nestjs/common';
import { computeEmailFingerprint } from '@aramo/common';
import { IdentityIndexRepository } from '@aramo/identity-index';

import type { EligibilityPolicy } from './eligibility-policy.port.js';

// Auth-Decoupling PR-3 (ADR-0021 §2) — the Aramo-side adapter that implements
// auth's EligibilityPolicy. It OWNS the fingerprint computation (R-P23-3):
// computeEmailFingerprint(emailNormalized) → findClusterByFingerprint →
// { subject_ref: cluster.id } | null. This is the inversion that lets auth stop
// computing fingerprints and stop needing ARAMO_IDENTITY_PEPPER — the pepper
// coupling is removed from auth BY CONSTRUCTION.
//
// ORACLE-RESISTANCE (R-P23-5): a MISS returns null, NEVER throws — byte-identical
// to the old inline `cluster?.id ?? null`. An underlying store error propagates
// exactly as the old inline code did (uniformly, before any eligibility branch),
// so the port hop introduces no distinguishable branch. This is the ONLY seam
// that imports @aramo/identity-index and computeEmailFingerprint;
// portal-login.service.ts no longer does (the §3.4 decoupling proof).
@Injectable()
export class IdentityIndexEligibilityAdapter implements EligibilityPolicy {
  constructor(private readonly identityIndex: IdentityIndexRepository) {}

  async resolve(emailNormalized: string): Promise<{ subject_ref: string } | null> {
    const fingerprint = computeEmailFingerprint(emailNormalized);
    const cluster = await this.identityIndex.findClusterByFingerprint(fingerprint);
    return cluster === null ? null : { subject_ref: cluster.id };
  }
}
