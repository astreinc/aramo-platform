import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

// M4 PR-7 §4.5 — HTTP request DTO for POST
// /v1/submittals/{submittal_id}/revoke.
//
// Single field: revocation_justification — the recruiter-authored
// rationale for the revoke. Persisted verbatim into the
// TalentSubmittalRecord.revocation_justification column by the
// repository's revokeSubmittal method.
//
// Inline constraints (directive §4.5): @IsString + @IsNotEmpty +
// @MaxLength(2000). The directive specifies a NEW
// RevokeSubmittalRequest schema with inline constraints rather than
// reusing the existing JustificationText schema (which is reserved
// for Worth Considering submittal justification per PR-3); the
// constraint envelope is identical (non-empty, max 2000) but the
// schema boundary is kept distinct so future tightening of one
// constraint set does not bleed into the other.

export class RevokeSubmittalRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  revocation_justification!: string;
}
