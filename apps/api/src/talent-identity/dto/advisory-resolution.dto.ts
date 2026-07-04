import { IsBoolean, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

// TR-2a-3 — request DTOs for the privileged advisory-resolution surface. The
// global ValidationPipe runs whitelist + forbidNonWhitelisted, so these classes
// (not interfaces) gate the body shape: unknown props are rejected.

const JUSTIFICATION_MAX = 2000;

// POST /v1/talent/identity/advisories/:id/approve
export class ApproveMergeRequestDto {
  // Which subject survives (must be one of the advisory pair). Optional — defaults
  // to the canonical-lower subject_a. The service rejects a non-pair id.
  @IsOptional()
  @IsUUID('all')
  surviving_subject_id?: string;

  // Reviewer justification. REQUIRED (with the ack) to override a contradiction (R3).
  @IsOptional()
  @IsString()
  @MaxLength(JUSTIFICATION_MAX)
  justification?: string;

  // Explicit acknowledgment of a contradiction override (R3 — F34 accountability).
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
export class ReverseMergeRequestDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(JUSTIFICATION_MAX)
  justification!: string;
}
