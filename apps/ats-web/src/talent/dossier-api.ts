import { apiClient } from '@aramo/fe-foundation';

// TR-14 B2 → ATI-SEP-1 T10 WP3b — the trust dossier read surface + the
// contradiction resolve wire. The dossier is Talent Intelligence's view of the
// record (TI owns trust), presented by the ATS: bands + statements + facts +
// contradictions as items + contact verification state. Read-only; the ONE
// write is the contradiction resolve (KEEP / RETRACT). NO trust-ordinal number
// crosses this wire (R10). TI is enrichment: `intelligence_status` says whether
// it is ENABLED, NOT_ENTITLED, NOT_CONFIGURED or UNAVAILABLE — the page renders
// an honest empty state for the last three, never an error.

export type IntelligenceStatus = 'ENABLED' | 'NOT_ENTITLED' | 'NOT_CONFIGURED' | 'UNAVAILABLE';

export interface DimensionAssessment {
  readonly band: string;
}
export interface DossierFact {
  readonly fact_type: string;
  readonly fact_key: string;
  readonly value: Readonly<Record<string, unknown>>;
  readonly state: string;
  readonly verification_status: string;
  readonly corroborated: boolean;
}
export interface ContradictionItem {
  readonly assertion_id: string;
  readonly assertion_type: string;
  readonly contributed_by: string;
  readonly assertion_payload: unknown;
  readonly observed_at: string;
}
export interface VerificationStateItem {
  readonly anchor_kind: string;
  readonly status: string;
  readonly disputed: boolean;
}
export interface DossierHead {
  readonly talent_record_id: string;
  readonly intelligence_status: IntelligenceStatus;
  readonly ledger_established: boolean;
  readonly dimensions: {
    readonly identity: DimensionAssessment;
    readonly claims: DimensionAssessment;
    readonly continuity: DimensionAssessment;
    readonly eligibility: DimensionAssessment;
  };
  readonly statements: readonly string[];
  readonly facts: readonly DossierFact[];
  readonly contradictions: readonly ContradictionItem[];
  readonly verifications: readonly VerificationStateItem[];
  readonly has_open_dispute: boolean;
  readonly generated_at: string | null;
}

export interface DossierEvidenceItem {
  readonly assertion_id: string;
  readonly assertion_type: string;
  readonly contributed_by: string;
  readonly source_kind: string;
  readonly verification_status: string;
  readonly status: string;
  readonly assertion_payload: unknown;
  readonly observed_at: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly ai_derived: boolean;
  readonly history: ReadonlyArray<{
    readonly event_type: string;
    readonly from_status: string | null;
    readonly to_status: string | null;
    readonly at: string;
  }>;
}
export interface DossierEvidencePage {
  readonly intelligence_status: IntelligenceStatus;
  readonly items: readonly DossierEvidenceItem[];
  readonly next_cursor: string | null;
}

export async function getDossier(recordId: string): Promise<DossierHead> {
  return apiClient.get<DossierHead>(`/v1/talent-records/${encodeURIComponent(recordId)}/dossier`);
}

export async function getDossierEvidence(recordId: string, cursor?: string | null): Promise<DossierEvidencePage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiClient.get<DossierEvidencePage>(`/v1/talent-records/${encodeURIComponent(recordId)}/dossier/evidence${qs}`);
}

export type ContradictionResolution = 'KEEP' | 'RETRACT';

export interface ResolveContradictionResult {
  readonly status: 'RESOLVED';
  readonly assertion_id: string;
  readonly resolution: ContradictionResolution;
  readonly assertion_status: string;
}

// identity:resolve. KEEP — the evidence stands; RETRACT — it is wrong (only
// evidence this workspace contributed). The caller refetches afterwards.
export async function resolveContradiction(
  assertionId: string,
  talentRecordId: string,
  reason: string,
  resolution: ContradictionResolution = 'KEEP',
): Promise<ResolveContradictionResult> {
  return apiClient.post<ResolveContradictionResult>(
    `/v1/talent/identity/contradictions/${encodeURIComponent(assertionId)}/resolve`,
    { talent_record_id: talentRecordId, reason, resolution },
  );
}

/** "Talent Intelligence not enabled" copy for a non-ENABLED status (null when enabled). */
export function intelligenceStatusNote(status: IntelligenceStatus): string | null {
  switch (status) {
    case 'ENABLED':
      return null;
    case 'UNAVAILABLE':
      return 'Talent Intelligence is temporarily unavailable.';
    default:
      return 'Talent Intelligence not enabled.';
  }
}
