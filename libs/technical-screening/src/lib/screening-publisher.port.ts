// TIP-E2E INC-3 — the outbound evidence-publication port (directive §3/§7).
// Screening never writes Talent Trust directly: apps/api binds an adapter over
// TalentTrustService.recordScreeningFindingIfAbsent (Aramo-TR-SCREEN-1-DDR §3).
// Every argument comes from the PINNED publication intent.
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
