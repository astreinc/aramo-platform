import type { EvidenceReferenceVerifierPort } from '@aramo/pipeline';

import { CommunicationsEvidenceReferenceVerifier } from '../../pipeline-evidence/evidence-reference-verifier.module.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2(a) — the evidence-reference verifier is
// MANDATORY for contacted / talent_responded. Shared wiring for hand-wired
// `new PipelineRepository(prisma, guard, verifier)` specs (CLAUDE.md shared-helper law):
//   * acceptingEvidenceVerifier() — substrate specs that drive the milestones but are not ABOUT
//     reference verification (the per-stage allowlist still applies);
//   * communicationsEvidenceVerifier() — the REAL composition-root verifier (needs the
//     communications schema in the container).
export function acceptingEvidenceVerifier(): EvidenceReferenceVerifierPort {
  return { verifyInTx: async () => ({ verified: true }) };
}

export function communicationsEvidenceVerifier(): EvidenceReferenceVerifierPort {
  return new CommunicationsEvidenceReferenceVerifier();
}
