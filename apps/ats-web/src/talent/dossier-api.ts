import { apiClient } from '@aramo/fe-foundation';

// TR-14 B2 — the trust dossier read surface + the TR-4 resolve wire. The dossier
// is the promoted talent's Trust Assessment: bands + statements + contradictions
// as items, verification, merge provenance. Read-only; the ONE write is the
// contradiction resolve (the existing TR-4 endpoint). NO trust-ordinal number
// crosses this wire (per R10) — only payload facts inside evidence detail.

export interface DimensionAssessment {
  readonly band: string;
}
export interface ContradictionItem {
  readonly evidence_id: string;
  readonly dimension: string;
  readonly assertion_type: string;
  readonly reason: string | null;
  readonly contradicting_evidence_id: string | null;
  readonly assertion_payload: unknown;
}
export interface VerificationStateItem {
  readonly anchor_kind: string;
  readonly status: string;
}
export interface MergeProvenanceItem {
  readonly operation_id: string;
  readonly kind: string;
  readonly role: 'survivor' | 'merged';
  readonly completed_at: string | null;
}
export interface DossierHead {
  readonly talent_record_id: string;
  readonly ledger_established: boolean;
  readonly dimensions: {
    readonly identity: DimensionAssessment;
    readonly claims: DimensionAssessment;
    readonly continuity: DimensionAssessment;
    readonly eligibility: DimensionAssessment;
  };
  readonly statements: readonly string[];
  readonly contradictions: readonly ContradictionItem[];
  readonly verifications: readonly VerificationStateItem[];
  readonly merge_provenance: readonly MergeProvenanceItem[];
  readonly advisory_pointers: readonly string[];
  // TR-12 B2 — pointers (id + kind) toward the Trust Proposals queue; OPEN only.
  readonly proposal_pointers: readonly ProposalPointer[];
}
export interface ProposalPointer {
  readonly id: string;
  readonly kind: string;
}

// One evidence-timeline item. NOTE (R10): the evidence carries no `strength` — it
// is stripped server-side. Only payload facts (assertion_payload) may hold numbers.
export interface DossierEvidenceRow {
  readonly id: string;
  readonly dimension: string;
  readonly assertion_type: string;
  readonly assertion_payload: unknown;
  readonly source_class: string;
  readonly method: string;
  readonly current_status: string;
  readonly collected_at: string;
}
export interface DossierEvidenceItem {
  readonly event: {
    readonly id: string;
    readonly event_type: string;
    readonly actor: string | null;
    readonly reason: string | null;
    readonly linked_evidence_id: string | null;
    readonly occurred_at: string;
  };
  readonly evidence: DossierEvidenceRow;
  readonly links: ReadonlyArray<{
    readonly from_evidence_id: string;
    readonly to_evidence_id: string;
    readonly relation: string;
  }>;
}
export interface DossierEvidencePage {
  readonly items: readonly DossierEvidenceItem[];
  readonly next_cursor: string | null;
}

export async function getDossier(recordId: string): Promise<DossierHead> {
  return apiClient.get<DossierHead>(`/v1/talent-records/${encodeURIComponent(recordId)}/dossier`);
}

export async function getDossierEvidence(
  recordId: string,
  cursor?: string | null,
): Promise<DossierEvidencePage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiClient.get<DossierEvidencePage>(
    `/v1/talent-records/${encodeURIComponent(recordId)}/dossier/evidence${qs}`,
  );
}

// The TR-4 resolve endpoint (identity:resolve). On success the caller refetches
// the dossier so the lifted (VALID) state renders.
export async function resolveContradiction(
  evidenceId: string,
  reason: string,
): Promise<{ status: string; evidence_id: string }> {
  return apiClient.post<{ status: string; evidence_id: string }>(
    `/v1/talent/identity/contradictions/${encodeURIComponent(evidenceId)}/resolve`,
    { reason },
  );
}
