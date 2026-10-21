import type { EvidenceReferenceVerifierPort } from '../../lib/evidence-reference-verifier.port.js';

// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2(a) — the evidence-reference verifier
// is MANDATORY for the evidence-backed milestones (an unbound verifier refuses them). The ONE
// shared stub for hand-wired `new PipelineRepository(prisma, guard, verifier)` substrate specs
// that drive contacted / talent_responded but are not ABOUT reference verification: every
// reference verifies. The per-stage ALLOWLIST still applies (it is pure, in the repository).
// The real verifier (Communications-backed) is proven in apps/api (s4-* specs).
export const ACCEPTING_EVIDENCE_VERIFIER: EvidenceReferenceVerifierPort = {
  verifyInTx: async () => ({ verified: true }),
};

// v1.2 §7.2 — synthetic evidence of an ADMISSIBLE kind for the stage (talent_responded rests on a
// recruiter response confirmation only; contacted on a communication interaction).
export function syntheticEvidenceFor(target: string, id: string): { kind: string; id: string } {
  return { kind: target === 'talent_responded' ? 'recruiter_response_confirmation' : 'communication_interaction', id };
}
