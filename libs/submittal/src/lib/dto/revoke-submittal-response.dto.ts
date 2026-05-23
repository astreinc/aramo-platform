import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M4 PR-7 §4.5 — HTTP response DTO for POST
// /v1/submittals/{submittal_id}/revoke.
//
// Two fields:
//   - submittal — the updated TalentSubmittalRecord (state='revoked',
//     revoked_at + revoked_by + revocation_justification populated).
//   - evidence_package_mutated — LOCKED literal-type `false`. Every
//     successful revoke response affirms that the referenced
//     TalentJobEvidencePackage row is byte-identical to its
//     pre-revoke snapshot, mirroring the override-create endpoint's
//     `examination_mutated: false` invariant (M4 PR-5 §4.4). The
//     repository's revokeSubmittal method touches ONLY
//     TalentSubmittalRecord; the controller emits the literal `false`
//     for contract-level documentation of the write-isolation
//     invariant. The literal-type lock prevents accidental drift.
export interface RevokeSubmittalResponseDto {
  submittal: TalentSubmittalRecordView;
  evidence_package_mutated: false;
}
