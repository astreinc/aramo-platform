// TIP-E2E INC-2 — TalentDossierReadPort (ARAMO-TIP-E2E-INC-2-v1.0-LOCKED §3.3 / §6).
//
// Presents the existing recruiter-facing dossier OUTCOMES (from DossierService),
// backed by the canonical talent_trust.EvidenceRecord + its TrustState projection.
// Presents, NEVER computes. The adapter delegates to DossierService — it does not
// recompute trust, expose internal trust machinery, or fuse TalentSkillEvidence.
export const TALENT_DOSSIER_READ_PORT = Symbol('TALENT_DOSSIER_READ_PORT');

// A verification OUTCOME (kind + status only; never PII).
export interface DossierVerificationOutcome {
  readonly anchor_kind: string;
  readonly status: string;
}

// Recruiter-facing dossier head OUTCOME. `ledger_established: false` for a record
// with no trust subject (not an error). Exposes the verification + advisory
// outcomes the INC-2 consumer (Talent-360) renders. The presentation bands +
// thinness statements remain owned by DossierService and are added to this contract
// only when a consumer needs them (avoids an unused surface); the port never
// recomputes trust or exposes the internal trust machinery / strength ordinal.
export interface DossierHead {
  readonly talent_record_id: string;
  readonly ledger_established: boolean;
  readonly verifications: readonly DossierVerificationOutcome[];
  readonly advisory_pointers: readonly string[];
}

export interface TalentDossierReadPort {
  // Recruiter-facing dossier head outcome for a talent record. Presents existing
  // DossierService outcomes; never computes; no internal trust machinery. Tenant-
  // scoped (DossierService.getDossier(tenant_id, recordId)); the consuming surface
  // enforces talent:read / @RequireSiteMatch.
  getDossierHead(input: {
    tenant_id: string;
    talent_record_id: string;
  }): Promise<DossierHead>;
}
