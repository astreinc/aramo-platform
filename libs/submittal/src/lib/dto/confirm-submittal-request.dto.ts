import { IsDefined, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

import type { TalentSubmittalRecordView } from './talent-submittal-record.view.js';

// M4 PR-4 §4.4 — HTTP request/response DTOs for POST
// /v1/submittals/{submittal_id}/confirm.
//
// Three locked attestations per Group 2 §2.6: the recruiter must affirm
// (a) the underlying evidence has been reviewed, (b) the entrustability
// constraints (§2.5) have been reviewed against the requisition, and
// (c) any risk flags surfaced on the pinned examination are acknowledged.
//
// Directive §11 self-audit resolution: each field is typed as the literal
// `true` for compile-time documentation and OpenAPI `const: true` for
// contract documentation, but the runtime enforcement is the controller's
// manual 3-line check (see SubmittalController.confirmSubmittal step 4).
// NO `@Equals(true)` decorators here — class-validator would surface the
// failure as VALIDATION_ERROR (400), which collides with the directive-
// mandated ATTESTATION_MISSING (422) code/status pair. The manual check
// at the controller throws the correct code/status; @IsDefined +
// @ValidateNested + @Type cover the "is the attestations object present
// and a valid object shape" check before the manual value check fires.

export class RecruiterAttestationsDto {
  talent_evidence_reviewed!: true;
  constraints_reviewed!: true;
  submittal_risk_acknowledged!: true;
}

export class ConfirmSubmittalRequestDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => RecruiterAttestationsDto)
  attestations!: RecruiterAttestationsDto;
}

// ConfirmSubmittalResponseDto — 200 response shape. Returns the updated
// TalentSubmittalRecord (state='submitted', confirmed_at populated).
export interface ConfirmSubmittalResponseDto {
  submittal: TalentSubmittalRecordView;
}
