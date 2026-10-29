// Aramo-Sign-Executed-Artifact-Custody-and-Isolation-Directive-v1_0-LOCKED, SX-2 item 7 —
// custody of the completed artifacts (executed PDFs, execution certificate, evidence
// snapshot) in the dedicated Sign artifact bucket. The composition root
// (apps/sign-service) binds this when the bucket is configured; unbound (or dark), the
// completion path is unchanged. libs/sign gains no storage SDK.

export const EXECUTED_ARTIFACT_CUSTODY_PORT = 'EXECUTED_ARTIFACT_CUSTODY_PORT';

// The ledger event that records one artifact's custody (key, version id, SHA-256).
// SignatureEvent.event_type is unconstrained TEXT; this is the only writer of it.
export const EXECUTED_ARTIFACT_CUSTODY_EVENT_TYPE = 'EXECUTED_ARTIFACT_CUSTODY_RECORDED';

export interface ExecutedArtifactCustodyPort {
  // Called after the executed and certificate rows are written (post-commit). Uploads
  // the artifacts and records custody. MUST NOT throw: a failure leaves the custody
  // columns NULL for the reconcile job and never fails the completion.
  recordCompletion(tenant_id: string, envelope_id: string): Promise<void>;
}
