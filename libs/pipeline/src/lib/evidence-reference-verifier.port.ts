// Talent Lifecycle R1–R5 Implementation Directive v1.2 §7.2(a)/(b) (S4) — the PORT by which the
// Pipeline verifies that an evidence reference is real BEFORE an evidence-backed milestone rests
// on it. Arbitrary ids are never trusted. The concrete verifier reads Communications (and, when
// one exists, a durable provider-receipt store), so it lives at the apps/api composition root and
// is bound to EVIDENCE_REFERENCE_VERIFIER @Global (ADR-0029 wall; no Pipeline→Communications
// edge) — mirroring QUALIFIED_TRANSITION_GUARD. A STRING token avoids the bare-class collision.
//
//   * MANDATORY for evidence-backed targets: a process without it bound REFUSES the transition
//     (PIPELINE_EVIDENCE_INADMISSIBLE, reason verifier_unbound) — it never skips the check.
//   * It runs INSIDE the transition transaction, on that transaction's connection, so the
//     reference it verified is the one the committed milestone rests on.

export const EVIDENCE_REFERENCE_VERIFIER = 'EVIDENCE_REFERENCE_VERIFIER';

/** The minimal raw-query surface of the Pipeline interactive transaction. */
export interface EvidenceVerifierTx {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface EvidenceReferenceInput {
  readonly tenant_id: string;
  readonly talent_id: string;
  readonly requisition_id: string;
  readonly kind: string;
  readonly id: string;
  readonly requestId: string;
}

export type EvidenceVerification =
  | { readonly verified: true }
  | { readonly verified: false; readonly reason: string };

export interface EvidenceReferenceVerifierPort {
  verifyInTx(tx: EvidenceVerifierTx, input: EvidenceReferenceInput): Promise<EvidenceVerification>;
}
