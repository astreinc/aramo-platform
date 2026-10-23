import { IsBoolean, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// TR-2a-3 — request DTOs for the privileged advisory-resolution surface.
// ATI-SEP-1 T10 WP2 — rebuilt on the ATS duplicate advisory: the survivor is
// named by its TalentRecord id (surviving_record_id; the trust-subject
// surviving_subject_id is retired). The
// global ValidationPipe runs whitelist + forbidNonWhitelisted, so these classes
// (not interfaces) gate the body shape: unknown props are rejected.

const JUSTIFICATION_MAX = 2000;

// POST /v1/talent/identity/advisories/:id/approve
export class ApproveMergeRequestDto {
  // Which record survives (must be one of the advisory pair). Optional — defaults
  // to the canonical-lower talent_record_a. The controller rejects a non-pair id.
  // Ignored for a SOURCED_ARRIVAL advisory (the arrival links to its record).
  @IsOptional()
  @IsUUID('all')
  surviving_record_id?: string;

  // Reviewer note recorded on the decision.
  @IsOptional()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string;

  // Accepted for wire compatibility; the ATS advisory carries no contradiction
  // state, so it has no effect.
  @IsOptional()
  @IsBoolean()
  override_acknowledged?: boolean;
}

// POST /v1/talent/identity/advisories/:id/dismiss
export class DismissRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string;
}

// POST /v1/talent/identity/advisories/:id/reverse — justification is REQUIRED (R4).
// The required-ness is enforced in the controller with the
// REVERSAL_JUSTIFICATION_REQUIRED domain code (not the generic pipe
// VALIDATION_ERROR), so the DTO is lenient (type-checks when present).
export class ReverseMergeRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string;
}
