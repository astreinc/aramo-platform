// TIP-E2E INC-3 — the outbound evidence-publication port (directive §3/§7).
// apps/api binds the adapter. ATI-SEP-1 T10 WP1: the binding is ATS-local
// (ScreeningLocalPublisherAdapter — publication state only, no trust-ledger
// write). Every argument comes from the PINNED publication intent.
//
// Contract: resolve { written } on a write or an identical replay; throw an error
// whose `code` is 'IDEMPOTENCY_KEY_CONFLICT' on a conflicting replay; any other
// throw is a transient failure (the intent stays PENDING).

export const SCREENING_EVIDENCE_PUBLISHER = Symbol('SCREENING_EVIDENCE_PUBLISHER');

export interface ScreeningEvidencePublishInput {
  tenant_id: string;
  talent_record_id: string;
  evidence_id: string;
  assertion_payload: Record<string, unknown>;
  collected_at: Date;
}

export interface ScreeningEvidencePublisher {
  publish(input: ScreeningEvidencePublishInput): Promise<{ written: boolean }>;
}
