// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2 (S4, A1 AM-4; LR L-5 REVISED) — the
// per-stage evidence allowlist, PURE. An evidence-backed milestone rests only on these kinds:
//   contacted        ← communication_interaction · recruiter_response_confirmation ·
//                      provider_observation (only with a durable verified receipt, §7.2(b))
//   talent_responded ← recruiter_response_confirmation ONLY (a provider / telecom fact is never,
//                      by itself, a substantive response — A1 §5.1)
// Any other kind → PIPELINE_EVIDENCE_INADMISSIBLE. `inbound_application` is NOT listed (S5 deferred).

export const PIPELINE_EVIDENCE_KINDS = [
  'communication_interaction',
  'recruiter_response_confirmation',
  'provider_observation',
] as const;
export type PipelineEvidenceKind = (typeof PIPELINE_EVIDENCE_KINDS)[number];

export const ADMISSIBLE_EVIDENCE_BY_STAGE: Readonly<Record<'contacted' | 'talent_responded', readonly PipelineEvidenceKind[]>> = {
  contacted: ['communication_interaction', 'recruiter_response_confirmation', 'provider_observation'],
  talent_responded: ['recruiter_response_confirmation'],
};

/** True when `kind` may ground `target` (the verifier still checks the reference itself). */
export function isEvidenceAdmissible(target: string, kind: string): boolean {
  if (target !== 'contacted' && target !== 'talent_responded') return false;
  return (ADMISSIBLE_EVIDENCE_BY_STAGE[target] as readonly string[]).includes(kind);
}
