// DOC-TEMPLATE-ADMIN-RTR-1 (§29-32) — the dependency-inversion PORT by which the
// (scope:ats) Pipeline gates the `qualified` milestone on an RTR precondition WITHOUT
// importing @aramo/documents / the ATS readiness composition (ADR-0029 Pipeline⊥ATS
// wall). The Pipeline owns the `qualified` transition; the RTR readiness decision is
// ATS/Documents truth, so the concrete guard lives at the apps/api composition root
// and is bound to QUALIFIED_TRANSITION_GUARD @Global — mirroring RESUME_EDITION_READER.
// A STRING token (not the bare interface) avoids the non-strict app.get bare-class
// provider-collision trap.
//
// Injected @Optional into PipelineController: with no provider the generic transition
// path is unchanged (ungated), so every hand-wired controller test site boots. The
// backend remains authoritative; this is the ONE place the recruiting `qualified`
// milestone is joined to the RTR evidence predicate.

export const QUALIFIED_TRANSITION_GUARD = 'QUALIFIED_TRANSITION_GUARD';

export interface QualifiedTransitionGuardPort {
  // Assert that a pipeline MAY enter `qualified`. CONDITIONAL (§30): a no-op when the
  // client policy does not require an RTR for the requisition; otherwise it requires an
  // EXECUTED RIGHT_TO_REPRESENT for the EXACT (talent, requisition) and THROWS
  // (PIPELINE_QUALIFY_REQUIRES_RTR, 422) when none exists. `qualifying` entry is never
  // gated — only the `qualified` target reaches this guard. A missing/invisible pipeline
  // is a no-op here (the repository transition conceals it as 404 immediately after).
  assertCanQualify(input: { tenant_id: string; pipeline_id: string; requestId: string }): Promise<void>;
}
