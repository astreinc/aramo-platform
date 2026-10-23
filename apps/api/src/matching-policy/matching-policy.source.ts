import { Injectable } from '@nestjs/common';
import {
  parseEvidenceThresholds,
  type MatchingPolicy,
  type MatchingPolicySource,
} from '@aramo/matching';
import { MatchingPolicyRepository } from '@aramo/skills-taxonomy';

// ATI-SEP-1 A2 A-c (P1) — binds the libs/matching MATCHING_POLICY_SOURCE port to the
// platform-owned store (skills_taxonomy."MatchingPolicyVersion"). The store treats the
// thresholds document as opaque, so the strict libs/matching parser runs here on the
// way out: a malformed stored version THROWS (matching refuses to run on a policy it
// cannot read) rather than silently falling back to the compiled defaults. No ACTIVE
// version → null → MatchingService applies the compiled defaults.
@Injectable()
export class StoreMatchingPolicySource implements MatchingPolicySource {
  constructor(private readonly store: MatchingPolicyRepository) {}

  async getActivePolicy(): Promise<MatchingPolicy | null> {
    const active = await this.store.getActive();
    if (active === null) return null;
    const parsed = parseEvidenceThresholds(active.evidence_thresholds);
    if (!parsed.ok) {
      throw new Error(
        `Active matching policy version ${String(active.version_number)} is malformed: ${parsed.errors.join('; ')}`,
      );
    }
    return { version_number: active.version_number, evidence_thresholds: parsed.thresholds };
  }
}
